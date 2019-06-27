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

// DO NOT SUBMIT All of this could actually live in the VirtualContent
// class but it would be a lot of boilerplate to hide all of the
// methods etc. This is easier and does actually provide a small bit
// of separation of logic. Is it OK?

// Manages the visibility (locked/unlocked state) of a list of
// elements. This list of elements is assumed to be in vertical
// display order (e.g. from lowest to highest offset).
//
// It uses resize and intersection observers on all of the visible
// elements to ensure that changes that impact visibility cause us to
// recalulate things (e.g. scrolling, restyling).
class VisibilityManager {
  #sizeManager = new SizeManager();
  #elements;
  #syncRAFToken;

  #elementIntersectionObserver;
  #elementResizeObserver;

  #revealed = new Set();

  constructor(elements) {
    this.#elements = elements;

    this.#elementIntersectionObserver = new IntersectionObserver(() => {
      this.scheduleSync();
    });

    this.#elementResizeObserver = new ResizeObserver(() => {
      this.scheduleSync();
    });

    for (const element of this.#elements) {
      this.didAdd(element);
    }
    this.scheduleSync();
  }

  // Attempts to unlock a range of elements suitable for the current
  // viewport.
  //
  // This causes one forced layout. The forced layout occurs at the
  // start. We then use the laid out coordinates (which are based on a
  // mix of real sizes for unlocked elements and the estimated sizes
  // at the time of locking for locked elements) to calculate a set of
  // elements which should be revealed and we use unlock/lock to move
  // to this new set of revealed elements. We will check in the next
  // frame whether we got it correct.
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
      this.scheduleSync();
    }
  }

  // Returns an ElementBounds object who's low element contains or is
  // lower than |low| (or the lowest element possible). Similarly for
  // high.
  findElementBounds(low, high) {
    const lowElement = FindElement.findElement(this.#elements, low, FindElement.BIAS_LOW);
    const highElement = FindElement.findElement(this.#elements, high, FindElement.BIAS_HIGH);

    return new ElementBounds(lowElement, highElement);
  }

  // Updates the size manager with all of the currently revealed
  // elements' sizes.
  measureRevealed() {
    for (const element of this.#revealed) {
      this.#sizeManager.measure(element);
    }
  }

  // Reveals |element| so that it can be rendered. This includes
  // unlocking and adding to various observers.
  reveal(element) {
    this.#revealed.add(element);
    this.#elementIntersectionObserver.observe(element);
    this.#elementResizeObserver.observe(element);
    this.unlock(element);
  }

  unlock(element) {
    element.displayLock.commit().then(null, reason => {
      // TODO: Figure out how the LAPIs logging story.
      // console.log('Commit rejected: ', element, reason);
    });
  }

  // Hides |element| so that it cannot be rendered. This includes
  // locking and remove from various observers.
  hide(element) {
    this.#revealed.delete(element);
    this.#elementIntersectionObserver.unobserve(element);
    this.#elementResizeObserver.unobserve(element);
    element.displayLock.acquire({
      timeout: Infinity,
      activatable: true,
      size: [LOCKED_WIDTH, this.#sizeManager.getHopefulSize(element)],
    }).then(null, reason => {
      // TODO: Figure out how the LAPIs logging story.
      // console.log('Acquire rejected: ', element, reason);
    });
  }

  // Set things up correctly when an element has been added.
  didAdd(element) {
    // Added children should be invisible initially. We want to make them
    // invisible at this MutationObserver timing, so that there is no
    // frame where the browser is asked to render all of the children
    // (which could be a lot).
    this.hide(element);
  }

  // Set things up correctly when an element has been removed.
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

  // Ensure that
  scheduleSync() {
    if (this.#syncRAFToken !== undefined) {
      return;
    }

    this.#syncRAFToken = window.requestAnimationFrame(() => {
      this.#syncRAFToken = undefined;
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
      this.scheduleSync();
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
      this.#visibilityManager.scheduleSync();
    });
    this.#resizeObserver.observe(this);

    this.#mutationObserver = new MutationObserver(records => {
      this.#visibilityManager.applyMutationObserverRecords(records);
    });
    this.#mutationObserver.observe(this, {childList: true});
  }
}
