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

function composedTreeParent(node) {
  return node.assignedSlot || node.host || node.parentNode;
}

function nearestScrollingAncestor(node) {
  // TODO(fergal): This returns the HTML element but in that case we
  // need the document.
  for (node = composedTreeParent(node); node !== null;
       node = composedTreeParent(node)) {
    if (node.nodeType === Node.ELEMENT_NODE &&
        node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

// Represents an offset for the scroller. Can be either an pixel
// offset or an element.
class Offset {
  constructor(offset, element) {
    this.offset = offset;
    this.element = element;
  }
}

// Represents a range of pixels, from |low| to |high|. |lowElement| if present
// is an element having lowest edge equal to |low| and |highElement| if present
// is an element having highest edge equal to |high|.
class Range {
  constructor(low, high, lowElement, highElement) {
    if (DEBUG) {
      if (low > high) {
        throw Error(low + " > " + high);
     }
    }
    this.low = low;
    this.high = high;
    this.lowElement = lowElement;
    this.highElement = highElement;
  }

  // this :  -----------
  // other:    ------
  // result: --      ---
  minus(other) {
    let result = [];
    if (this.low < other.low) {
      result.push(new Range(this.low, other.low, this.lowElement,
                            other.lowElement ? other.lowElement.previousElementSibling : null));
    }
    if (this.high > other.high) {
      result.push(new Range(other.high, this.high,
                            other.highElement ? other.highElement.nextElementSibling : null,
                            this.highElement));
    }
    return result;
  }

  getThisSize() {
    return this.high - this.low;
  }

  overlaps(other) {
    let low = this.low < other.low ? this : other;
    let high = this.high > other.high ? this : other;
    return low.high >= high.low;
  }

  merge(other) {
    let low = this.low < other.low ? this : other;
    let high = this.high > other.high ? this : other;
    if (low.high < high.low) {
      throw "Cannot merge, no overlap";
    }
    // TODO: Handle 0-width elements in case of equal bounds.
    return new Range(low.low, high.high, low.lowElement, high.highElement);
  }

  sameEnds(other) {
    return other.lowElement === this.lowElement && other.highElement === this.highElement;
  }

  doToAll(fn) {
    let element = this.lowElement;
    while (true) {
      fn(element);
      if (element === this.highElement) {
        break;
      }
      element = element.nextElementSibling;
    }
  }

  elementSet() {
    let result = new Set();
    let element = this.lowElement;
    while (element) {
      result.add(element);
      if (element == this.highElement) {
        break;
      }
      element = element.nextElementSibling;
    }
    return result;
  }
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

    this.intersectionObserver =
      new IntersectionObserver(entries => {this.intersectionObserverCallback(entries)});

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

    let windowBounds = new Range(0, window.innerHeight);
    let newRevealedBounds;
    // Grab sizes of all revealed elements for the record.
    this.measureRevealed();
    newRevealedBounds = this.revealHopefulBounds(windowBounds);
    let newRevealed = newRevealedBounds.elementSet();
    if (this.debug) console.log("newRevealedBounds after trim", newRevealedBounds);
    let toHide = this.setDifference(this.revealed, newRevealed);
    if (this.debug) console.log("toHide", toHide);
    toHide.forEach(e => this.requestHide(e));

    let toReveal = this.setDifference(newRevealed, this.revealed);
    if (this.debug) console.log("toReveal", toReveal);
    toReveal.forEach(e => this.requestReveal(e));
    // If we are being lazy and not forcing layouts, we need to
    // check again in the next frame to see if we have more work
    // to do.
    if (toHide.size > 0 || toReveal.size > 0) {
      this.scheduleUpdate();
      // We had to make an adjustment, so count this frame.
      this.framesOfSync++;
    } else {
      // We're finished making adjustments, so log the final
      // count.
      console.log("framesOfSync", this.framesOfSync);
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

  // a - b
  setDifference(a, b) {
    let result = new Set();
    for (const element of a) {
      if (!b.has(element)) {
        result.add(element)
      }
    }
    return result;
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

  findElementIndex(offset) {
    let low = 0;
    let high = this.children.length - 1;
    let i;
    while (true) {
      if (low === high) {
        return low;
      }
      i = Math.floor((low + high)/2);
      let element = this.children[i];
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

  findElement(offset) {
    return this.children[this.findElementIndex(offset)];
  }

  revealHopefulBounds(bounds) {
    let lowElement = this.findElement(bounds.low);
    let highElement = this.findElement(bounds.high);

    return this.range(lowElement, highElement);
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

  requestReveal(element) {
    if (this.getRevealed(element)) {
      if (DEBUG) {
        throw "is already revealed: " + element;
      }
    } else {
      this.reveal(element);
    }
  }

  requestHide(element) {
    if (!this.getRevealed(element)) {
      if (this.debug) {
        throw "is already hidden: " + element;
      }
    } else {
      this.hide(element);
    }
  }

  range(lowElement, highElement) {
    return new Range(lowElement.getBoundingClientRect().top, highElement.getBoundingClientRect().bottom,
                     lowElement, highElement);
  }

  intersectionObserverCallback(entries) {
    this.scheduleUpdate();
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
