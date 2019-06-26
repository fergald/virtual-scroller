const BUFFER = 0.2;
const DEFAULT_HEIGHT_ESTIMATE = 100;
const LOCKED_WIDTH = 1;

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
  const result = new Set();
  for (const element of a) {
    if (!b.has(element)) {
      result.add(element);
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
    const result = new Set();
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
    i = Math.floor((low + high) / 2); // eslint-disable-line no-magic-numbers
    const element = elements[i];
    const rect = element.getBoundingClientRect();
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
  const lowElement = findElement(elements, low);
  const highElement = findElement(elements, high);

  return new ElementBounds(lowElement, highElement);
}

class SizeManager {
  sizes = new WeakMap();
  sizeValid = new WeakMap();

  totalMeasuredSize = 0;
  measuredCount = 0;

  ensureValidSize(element) {
    if (this.sizeValid.get(element)) {
      return;
    }
    let oldSize = this.sizes.get(element);
    if (oldSize === undefined) {
      oldSize = 0;
      this.measuredCount++;
    }
    const newSize = element.offsetHeight;
    this.totalMeasuredSize += newSize - oldSize;
    this.sizes.set(element, newSize);
    this.sizeValid.set(element, true);
  }

  invalidate(element) {
    this.sizeValid.set(element, false);
  }

  getHopefulSize(element) {
    const size = this.sizes.get(element);
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

  constructor() {
    super();

    const shadowRoot = this.attachShadow({mode: 'closed'});
    shadowRoot.innerHTML = TEMPLATE;

    this.intersectionObserver = new IntersectionObserver(() => {
      this.scheduleUpdate();
    });

    this.thisResizeObserver = new ResizeObserver(() => {
      this.scheduleUpdate();
    });
    this.thisResizeObserver.observe(this);

    this.elementResizeObserver = new ResizeObserver(entries => {
      this.elementResizeObserverCallback(entries);
    });

    this.mutationObserver = new MutationObserver(records => {
      this.mutationObserverCallback(records);
    });
    this.mutationObserver.observe(this, {childList: true});
    // Send a MutationRecord-like object with the current, complete list of
    // child nodes to the MutationObserver callback; these nodes would not
    // otherwise be seen by the observer.
    this.mutationObserverCallback([
      {
        type: 'childList',
        target: this,
        addedNodes: Array.from(this.childNodes),
        removedNodes: [],
        previousSibling: null,
        nextSibling: null,
      },
    ]);

    this.scheduleUpdate();
  }

  sync() {
    if (this.childNodes.length === 0) {
      return;
    }

    this.measureRevealed();
    const desiredLow = 0 - window.innerHeight * BUFFER;
    const desiredHigh = window.innerHeight + window.innerHeight * BUFFER;
    const newBounds = findElementBounds(this.children, desiredLow, desiredHigh);
    const newRevealed = newBounds.elementSet();

    const toHide = setDifference(this.revealed, newRevealed);
    toHide.forEach(e => this.hide(e));

    const toReveal = setDifference(newRevealed, this.revealed);
    toReveal.forEach(e => this.reveal(e));

    // Now we have revealed what we hope will fill the screen. If we
    // actually made a change, we should come back next frame and
    // verify whether we have revealed the right amount.
    if (toHide.size > 0 || toReveal.size > 0) {
      this.scheduleUpdate();
    }
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
    element.displayLock.commit().then(null, reason => {
      console.log('Rejected: ', reason);
    });
  }

  hide(element) {
    this.revealed.delete(element);
    this.intersectionObserver.unobserve(element);
    this.elementResizeObserver.unobserve(element);
    element.displayLock.acquire({
      timeout: Infinity,
      activatable: true,
      size: [LOCKED_WIDTH, this.sizeManager.getHopefulSize(element)],
    }).then(null, reason => {
      console.log('Rejected: ', reason.message);
    });
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
    if (this.updateRAFToken !== undefined) {
      return;
    }

    this.updateRAFToken = window.requestAnimationFrame(() => {
      this.updateRAFToken = undefined;
      this.sync();
    });
  }
}
