import * as Sets from './Sets.mjs';
import * as FindElement from './FindElement.mjs';


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

// Represents a range of elements from |low| to |high|.
class ElementBounds {
  constructor(low, high) {
    this.low = low;
    this.high = high;
  }

  // Creates a Set containing all of the elements from low to high.
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

// Manages measuring and estimating sizes of elements.
class SizeManager {
  #sizes = new WeakMap();

  #totalMeasuredSize = 0;
  #measuredCount = 0;

  // Measures and stores the element's size if we don't already have a
  // valid measurement.
  measure(element) {
    let oldSize = this.#sizes.get(element);
    if (oldSize === undefined) {
      oldSize = 0;
      this.#measuredCount++;
    }
    const newSize = element.offsetHeight;
    this.#totalMeasuredSize += newSize - oldSize;
    this.#sizes.set(element, newSize);
  }

  // Returns a size for this element, either the last stored size or
  // an estimate based on previously measured elements or a default.
  getHopefulSize(element) {
    const size = this.#sizes.get(element);
    return size === undefined ? this._getAverageSize() : size;
  }

  _getAverageSize() {
    return this.#measuredCount > 0 ?
      this.#totalMeasuredSize / this.#measuredCount :
      DEFAULT_HEIGHT_ESTIMATE;
  }

  // Removes all data related to |element| from the manager.
  remove(element) {
    let oldSize = this.#sizes.get(element);
    if (oldSize === undefined) {
      return;
    }
    this.#totalMeasuredSize -= oldSize;
    this.#measuredCount--;
    this.#sizes.delete(element);
  }
}

// DO NOT SUBMIT Factoring this out from VirtualContent makes it easy
// to hide all of the internals but it

// Manages the visibility (locked/unlocked state) of a list of
// elements.
class VisibilityManager {
  #sizeManager = new SizeManager();
  #elements;
  #updateRAFToken;

  #elementIntersectionObserver;
  #elementResizeObserver;

  #revealed = new Set();

  constructor(elements) {
    this.#elements = elements;

    this.#elementIntersectionObserver = new IntersectionObserver(() => {
      this.scheduleUpdate();
    });


    this.#elementResizeObserver = new ResizeObserver(entries => {
      this.elementResizeObserverCallback(entries);
    });

    for (const element of this.#elements) {
      this.didAdd(element);
    }
    this.scheduleUpdate();
  }

  // Attempts to unlock a range of elements that are visible on-screen.
  // This causes one forced layout.
  sync() {
    if (this.#elements.length === 0) {
      return;
    }

    // This causes a forced layout and takes measurements of all
    // currently revealed elements.
    this.measureRevealed();

    // Compute the pixel bounds of what we would like to reveal. Then
    // find the elements corresponding to these bounds.
    const desiredLow = 0 - window.innerHeight * BUFFER;
    const desiredHigh = window.innerHeight + window.innerHeight * BUFFER;
    const newBounds = this.findElementBounds(desiredLow, desiredHigh);
    const newRevealed = newBounds.elementSet();

    // Lock and unlock the minimal set of elements to get us to the
    // new state.
    const toHide = Sets.difference(this.#revealed, newRevealed);
    toHide.forEach(e => this.hide(e));
    const toReveal = Sets.difference(newRevealed, this.#revealed);
    toReveal.forEach(e => this.reveal(e));

    // Now we have revealed what we hope will fill the screen. It
    // could be incorrect. Rather than measuring now and correcting it
    // which would involve an unknown number of forced layouts, we
    // come back next frame and try to make it better. We know we can
    // stop when we didn't hide or reveal any elements.
    if (toHide.size > 0 || toReveal.size > 0) {
      this.scheduleUpdate();
    }
  }

  findElementBounds(low, high) {
    const lowElement = FindElement.findElement(this.#elements, low, FindElement.BIAS_LOW);
    const highElement = FindElement.findElement(this.#elements, high, FindElement.BIAS_HIGH);

    return new ElementBounds(lowElement, highElement);
  }

  // Updates the size manager with all of the revealed elements'
  // sizes.
  measureRevealed() {
    for (const element of this.#revealed) {
      this.#sizeManager.measure(element);
    }
  }

  // Reveals an |element| so that it can be rendered. This includes
  // unlocks and adding to various observers.
  reveal(element) {
    this.#revealed.add(element);
    this.#elementIntersectionObserver.observe(element);
    this.#elementResizeObserver.observe(element);
    this.unlock(element);
  }

  unlock(element) {
    element.displayLock.commit().then(null, reason => {
      console.log('Rejected: ', reason);
    });
  }

  hide(element) {
    this.#revealed.delete(element);
    this.#elementIntersectionObserver.unobserve(element);
    this.#elementResizeObserver.unobserve(element);
    element.displayLock.acquire({
      timeout: Infinity,
      activatable: true,
      size: [LOCKED_WIDTH, this.#sizeManager.getHopefulSize(element)],
    }).then(null, reason => {
      console.log('Rejected: ', reason.message);
    });
  }

  didAdd(element) {
    // Added children should be invisible initially. We want to make them
    // invisible at this MutationObserver timing, so that there is no
    // frame where the browser is asked to render all of the children
    // (which could be a lot).
    this.hide(element);
  }

  didRemove(element) {
    // Removed children should be made visible again. We should stop
    // observing them and discard any size info we have for them as it
    // may have become incorrect.
    this.#revealed.delete(element);
    if (element.displayLock.locked) {
      this.unlock(element);
    }
    this.#elementIntersectionObserver.unobserve(element);
    this.#elementResizeObserver.unobserve(element);
    this.#sizeManager.remove(element);
  }

  elementResizeObserverCallback(entries) {
    this.scheduleUpdate();
  }

  scheduleUpdate() {
    if (this.#updateRAFToken !== undefined) {
      return;
    }

    this.#updateRAFToken = window.requestAnimationFrame(() => {
      this.#updateRAFToken = undefined;
      this.sync();
    });
  }

  applyMutationObserverRecords(records) {
    // It's unclear if we can support children which are not
    // elements. We cannot control their visibility using display
    // locking but we can just leave them alone.
    //
    // Relevant mutations are any additions or removals, including
    // non-element as this may impact element bounds.
    let relevantMutation = false;
    const toRemove = new Set();
    for (const record of records) {
      relevantMutation = relevantMutation || record.removedNodes.size > 0;
      for (const node of record.removedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          toRemove.add(node);
        }
      }
    }

    const toAdd = new Set();
    for (const record of records) {
      relevantMutation = relevantMutation || record.addedNodes.size > 0;
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (toRemove.has(node)) {
            toRemove.delete(node);
          } else {
            toAdd.add(node);
          }
        }
      }
    }
    for (const node of toRemove) {
      this.didRemove(node);
    }
    for (const node of toAdd) {
      this.didAdd(node);
    }

    if (relevantMutation) {
      this.scheduleUpdate();
    }
  }
}

export class VirtualContent extends HTMLElement {
  #visibilityManager;
  #mutationObserver;
  #resizeObserver;

  constructor() {
    super();

    const shadowRoot = this.attachShadow({mode: 'closed'});
    shadowRoot.innerHTML = TEMPLATE;

    this.#visibilityManager = new VisibilityManager(this.childNodes);

    this.#resizeObserver = new ResizeObserver(() => {
      this.#visibilityManager.scheduleUpdate();
    });
    this.#resizeObserver.observe(this);

    this.#mutationObserver = new MutationObserver(records => {
      this.#visibilityManager.applyMutationObserverRecords(records);
    });
    this.#mutationObserver.observe(this, {childList: true});
  }
}
