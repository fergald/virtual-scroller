const DEBUG = false;
const BUFFER = .2;
const DEFAULT_HEIGHT_ESTIMATE = 100;

const TEMPLATE = `
<style>
:host {
  /* Browsers will automatically change the scroll position after we modify the
   * DOM, unless we turn it off with this property. We want to do the adjustments
   * ourselves in [_update](), instead. */
  overflow-anchor: none;
  display: block;
}

::slotted(*) {
  display: block !important;
  contain: layout style
}

</style>
<slot></slot>
`;

// a - b
function setDifference(a, b) {
  let result = new Set();
  for (const element of a) {
    if (!b.has(element)) {
      result.add(element)
    }
  }
  return result;
}

// Represents a range of elements from |low| to |high|.
class ElementBounds {
  constructor(low, high) {
    this.low = low;
    this.high = high;
  }

  elementSet() {
    let result = new Set();
    let element = this.low;
    while (element) {
      result.add(element);
      if (element === this.high) {
        break;
      }
      element = element.nextElementSibling;
    }
    return result;
  }
}

function findElementIndex(elements, offset) {
  let low = 0;
  let high = elements.length - 1;
  let i;
  while (true) {
    if (low === high) {
      return low;
    }
    i = Math.floor((low + high)/2);
    let element = elements[i];
    let rect = element.getBoundingClientRect();
    if (rect.top > offset) {
      // The entire rect is > offset.
      high = Math.max(i - 1, low);
    } else if (rect.bottom < offset) {
      // The entire rect is < offset.
      low = Math.min(i + 1, high);
    } else {
      // The rect contains offset.
      break;
    }
  }
  return i;
}

function findElement(elements, offset) {
  return elements[findElementIndex(elements, offset)];
}

function findElementBounds(elements, low, high) {
  let lowElement = findElement(elements, low);
  let highElement = findElement(elements, high);

  return new ElementBounds(lowElement, highElement);
}

class SizeManager {
  sizes = new WeakMap();
  sizeValid = new WeakMap();

  totalMeasuredSize = 0;
  measuredCount = 0;

  ensureValidSize(element) {
    if (this.sizeValid.get(element)) {
      if (this.debug) {
        if (this.sizes.has(element) === undefined) {
          throw "No size for valid size: " + element;
        }
      }
      return;
    }
    let oldSize = this.sizes.get(element);
    if (oldSize === undefined) {
      oldSize = 0;
      this.measuredCount++;
    }
    let newSize = element.offsetHeight;
    this.totalMeasuredSize += newSize - oldSize;
    this.sizes.set(element, newSize);
    this.sizeValid.set(element, true);
  }

  invalidate(element) {
    this.sizeValid.set(element, false);
  }

  getHopefulSize(element) {
    let size = this.sizes.get(element);
    return size === undefined ? this.getAverageSize() : size;
  }

  getAverageSize() {
    return this.measuredCount > 0 ?
      this.totalMeasuredSize / this.measuredCount :
      DEFAULT_HEIGHT_ESTIMATE;
  }

  remove(element) {
    this.sizes.delete(element);
    this.sizeValid.delete(element);
  }
}

export class VirtualContent extends HTMLElement {
  sizeManager = new SizeManager();
  updateRAFToken;

  intersectionObserver;
  mutationObserver;
  elementResizeObserver;
  thisResizeObserver;

  revealed = new Set();

  // This tracks how many consecutive frames of layout we have done
  // (this number can be high because we had to do a lot of relayout
  // or just because the page or scroll-position was changing a lot).
  framesOfSync = 0;

  debug = DEBUG;

  constructor() {
    super();

    const shadowRoot = this.attachShadow({mode: 'closed'});
    shadowRoot.innerHTML = TEMPLATE;

    this.intersectionObserver = new IntersectionObserver(() => {this.scheduleUpdate()});

    this.thisResizeObserver = new ResizeObserver(() => {this.scheduleUpdate()});
    this.thisResizeObserver.observe(this);

    this.elementResizeObserver = new ResizeObserver(entries => {this.elementResizeObserverCallback(entries)});

    this.mutationObserver = new MutationObserver((records) => {this.mutationObserverCallback(records)});
    this.mutationObserver.observe(this, {childList: true});
    // Send a MutationRecord-like object with the current, complete list of
    // child nodes to the MutationObserver callback; these nodes would not
    // otherwise be seen by the observer.
    this.mutationObserverCallback([{
      type: 'childList',
      target: this,
      addedNodes: Array.from(this.childNodes),
      removedNodes: [],
      previousSibling: null,
      nextSibling: null,
    }]);

    this.scheduleUpdate();
  }

  setFromUrl(urlString, status) {
    let url = new URL(urlString);
    let params = url.searchParams;
    let setters = new Map([
      ["debug", [this.setDebug, "Emit lots of debug info"]],
    ]);

    for (let key of setters.keys()) {
      let value;
      let help;
      if (setters.has(key)) {
        let method;
        [method, help] = setters.get(key);
        value = method.bind(this)(params.get(key));
      }
      if (status) {
        let placeholder = status.getRootNode().getElementById(key + "-placeholder");
        if (!placeholder) {
          let div = document.createElement("div");
          div.innerHTML = `<code>${key}=<span id=${key}-placeholder>nnn</span></code> : ${help}`;
          status.appendChild(div);
          placeholder = status.getRootNode().getElementById(key + "-placeholder");
        }
        placeholder.innerText = value;
      }
    }
  }

  setDebug(debug) {
    return this.debug = parseInt(debug) || 0;
  }

  sync() {
    let start = performance.now();
    if (this.debug) console.log("sync");

    if (this.childNodes.length == 0) {
      return;
    }

    this.measureRevealed();
    let desiredLow = 0 - window.innerHeight * BUFFER;
    let desiredHigh =  window.innerHeight + window.innerHeight * BUFFER;
    let newBounds = findElementBounds(this.children, desiredLow, desiredHigh);
    if (this.debug) console.log("newBounds", newBounds);
    let newRevealed = newBounds.elementSet();
    let toHide = setDifference(this.revealed, newRevealed);
    if (this.debug) console.log("toHide", toHide);
    toHide.forEach(e => this.hide(e));

    let toReveal = setDifference(newRevealed, this.revealed);
    if (this.debug) console.log("toReveal", toReveal);
    toReveal.forEach(e => this.reveal(e));

    // Now we have revealed what we hope will fill the screen. If we
    // actually made a change, we should come back next frame and
    // verify whether we have revealed the right amount.
    if (toHide.size > 0 || toReveal.size > 0) {
      this.scheduleUpdate();
      // We had to make an adjustment, so count this frame.
      this.framesOfSync++;
    } else {
      // We're finished making adjustments, reset the counter.
      if (this.debug) console.log("framesOfSync", this.framesOfSync);
      this.framesOfSync = 0;
    }

    if (this.debug) console.log("revealCount", this.revealCount());

    let end = performance.now();
    if (this.debug) console.log("sync took: " + (end - start));
  }

  logInfo() {
    console.log("revealCount", this.revealCount());
    let bad = this.findBadLocks();
    if (bad.length > 0) {
      console.log("Bad locks", bad);
    } else {
      console.log("No bad locks");
    }
  }

  findBadLocks() {
    let bad = [];
    this.getBoundingClientRect();
    for (const element of this.children) {
      let locked = element.displayLock.locked;
      let revealed = this.revealed.has(element);
      if (locked == revealed) {
        bad.push([element, locked, revealed]);
      }
    }
    return bad;
  }

  revealCount() {
    if (this.debug) {
      let count = 0;
      for (const element of this.children) {
        if (this.revealed.has(element)) {
          count++;
        }
      }
      if (count != this.revealed.size) {
        throw "count != this.revealed: " + count + ", " + this.revealed.size;
      }
    }
    return this.revealed.size;
  }

  measureRevealed() {
    for (const element of this.revealed) {
      this.sizeManager.ensureValidSize(element);
    }
  }

  reveal(element) {
    this.revealed.add(element);
    this.intersectionObserver.observe(element);
    this.elementResizeObserver.observe(element);
    this.unlock(element);
  }

  unlock(element) {
    element.displayLock.commit().then(null, reason => {console.log("Rejected: ", reason)});
  }

  hide(element) {
    this.revealed.delete(element);
    this.intersectionObserver.unobserve(element);
    this.elementResizeObserver.unobserve(element);
    element.displayLock.acquire({
      timeout: Infinity,
      activatable: true,
      size: [10, this.sizeManager.getHopefulSize(element)],
    }).then(null, reason => {console.log("Rejected: ", reason.message)});
    this.sizeManager.invalidate(element);
  }

  removeElement(element) {
    // Removed children should have be made visible again. We should
    // stop observing them and discard any size info we have to them
    // as it may become incorrect.
    this.revealed.delete(element);
    this.intersectionObserver.unobserve(element);
    this.elementResizeObserver.unobserve(element);
    this.sizeManager.remove(element);
    if (element.displayLock.locked) {
      this.unlock(element);
    }
  }

  addElement(element) {
    // Added children should be invisible initially. We want to make them
    // invisible at this MutationObserver timing, so that there is no
    // frame where the browser is asked to render all of the children
    // (which could be a lot).
    return this.hide(element);
  }

  mutationObserverCallback(records) {
    // TODO: Does a move of an element show up as a remove and
    // add?). Need to cope with that.
    let relevantMutation = false;
    for (const record of records) {
      for (const node of record.removedNodes) {
        relevantMutation = true;
        if (node.nodeType === Node.ELEMENT_NODE) {
          this.removeElement(node);
        }
      }

      for (const node of record.addedNodes) {
        relevantMutation = true;
        if (node.nodeType === Node.ELEMENT_NODE) {
          this.addElement(node);
        } else {
          // Remove non-element children because we can't control their
          // invisibility state or even prevent them from being rendered using
          // CSS (they aren't distinctly selectable).

          // These records are not coalesced, so test that the node is actually
          // a child of this node before removing it.
          if (node.parentNode === this) {
            this.removeChild(node);
          }
        }
      }
    }

    if (relevantMutation) {
      this.scheduleUpdate();
    }
  }

  elementResizeObserverCallback(entries) {
    for (const entry of entries) {
      this.sizeManager.invalidate(entry.target);
    }
    this.scheduleUpdate();
  }

  scheduleUpdate() {
    if (this.updateRAFToken !== undefined)
      return;

    this.updateRAFToken = window.requestAnimationFrame(() => {
      this.updateRAFToken = undefined;
      this.sync();
    });
  }
}
