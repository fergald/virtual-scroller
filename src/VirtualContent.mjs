const DEBUG = true;

function DLOG(...messages) {
  if (!DEBUG) {
    return;
  }
  console.log(...messages);
}

function composedTreeParent(node) {
  return node.assignedSlot || node.host || node.parentNode;
}

function nearestScrollingAncestor(node) {
  for (node = composedTreeParent(node); node !== null;
       node = composedTreeParent(node)) {
    if (node.nodeType === Node.ELEMENT_NODE &&
        node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

const DEFAULT_HEIGHT_ESTIMATE = 100;
const TEMPLATE = `
<style>
:host {
  /* Browsers will automatically change the scroll position after we modify the
   * DOM, unless we turn it off with this property. We want to do the adjustments
   * ourselves in [_update](), instead. */
  overflow-anchor: none;
}

#emptySpaceSentinelContainer {
  contain: size layout style;
  pointer-events: none;
  visibility: hidden;
  overflow: visible;
  position: relative;
  height: 0px;
}

#emptySpaceSentinelContainer > div {
  contain: strict;
  position: absolute;
  width: 100%;
}

::slotted(*) {
  display: block !important;
  position: relative !important;
  contain: layout style
}
</style>
<div id="innerContainer">
  <div id="emptySpaceSentinelContainer"></div>
  <slot></slot>
</div>
`;

class Offset {
  constructor(offset, element) {
    this.offset = offset;
    this.element = element;
  }
}

class Range {
  constructor(low, high, lowElement, highElement) {
    this.low = low;
    this.high = high;
    this.lowElement = lowElement;
    this.highElement = highElement;
  }

  // this :  -----------
  // other:    ------
  // result: --      ---
  minus(other) {
    let lowUncovered, highUncovered;
    if (this.low < other.low) {
      lowUncovered = new Range(this.low, other.low, this.lowElement)
    }
    if (this.high > other.high) {
      highUncovered = new Range(other.high, this.high, null, this.highElement)
    }
    return [lowUncovered, highUncovered];
  }
}

export class VirtualContent extends HTMLElement {
  #sizes = new WeakMap();
  #target;
  #toShow = new Set();
  #updateRAFToken;
  #intersectionObserver;
  #mutationObserver;
  #resizeObserver;
  // The inner container allows us to get the size of the scroller without
  // forcing layout of the containing doc.
  #innerContainer;
  #emptySpaceSentinelContainer;

  #innerRect;
  #unlockedBounds = new Range(0, 0);
  #toUnlock = new Set();

  #totalMeasuredSize = 0;
  #measuredCount = 0;

  constructor() {
    super();

    const shadowRoot = this.attachShadow({mode: 'closed'});
    shadowRoot.innerHTML = TEMPLATE;
    this.#emptySpaceSentinelContainer =
        shadowRoot.getElementById('emptySpaceSentinelContainer');
    this.#innerContainer =
        shadowRoot.getElementById('innerContainer');
    this.#innerRect = this.#innerContainer.getBoundingClientRect()

    this.#intersectionObserver =
        new IntersectionObserver(this.#intersectionObserverCallback);
    this.#mutationObserver =
        new MutationObserver(this.mutationObserverCallback);
    this.#resizeObserver = new ResizeObserver(this.resizeObserverCallback);
    this.#intersectionObserver.observe(this);

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
    this.#mutationObserver.observe(this, {childList: true});

    // `capture: true` helps support the nested <virtual-content> case. (Which
    // is not yet officially supported, but we're trying.) In particular, this
    // ensures that the events handlers happen from outermost <virtual-content>
    // inward, so that we remove invisible="" from the outside in. Then, by the
    // time we get to the innermost node, all of its parents are no longer
    // invisible="", and thus it will be rendered (allowing us to accurately
    // measure its height, etc.)
    this.addEventListener(
        'activateinvisible', this.onActivateinvisible, {capture: true});
  }

  setTarget(offset) {
    this.targetOffset(offset);
    this.scheduleUpdate();
  }

  update() {
    this.#updateRAFToken = undefined;

    if (target === undefined) {
      updateToInitial();
    } else if (target.element) {
      updateToElement(target);
    } else {
      updateToOffset(target.offset);
    }
  }

  updateToInitial() {
    this.displayLock.acquire();
    try {
      this.updateToInitialLocked();
    } finally {
      this.displayLock.commit();
    }
  }

  getBounds(rect) {
    // TODO: allow horizontal scrolling.
    return Range(rect.y, rect.height);
  }

  updateToInitialLocked() {
    let rect = innerContainer.getBoundingClientRect();
    let scrollerBounds = this.getBounds(rect);
    let uncovered = scrollerBounds.minus(this.revealedBounds);
    for (const bounds of uncovered) {
      if (bounds) {
        this.tryRevealBounds(bounds);
      }
    }
  }

  tryRevealBounds(bounds) {
    if (bounds.lowElement) {
      this.revealLower(bounds);
    } else if (bounds.highElement) {
      this.revealHigher(bounds);
    } else {
      this.revealBoth(bounds);
    }
  }

  requestReveal(element) {
    if (!element.displayLock.locked) {
      DLOG(element, "is already unlocked");
    }
    this.#toUnlock.add(element);
  }

  revealLower(bounds) {
    revealDirection(bounds, /* lower */ true);
  }

  revealHigher(bounds) {
    revealDirection(bounds, /* lower */ false);
  }

  revealDirection(bounds, lower) {
    let element = lower ? bounds.lowElement : bounds.highElement;
    let rect = startElement.getBoundingClientRect();
    let edge = lower ? rect.y : - (rect.y + rect.height);
    let limit = lower ? bounds.low : - bounds.high;
    for (const element of findElements(element, edge, limit, lower)) {
      requestReveal(element);
    }
  }

  findElements(element, edge, limit, lower) {
    let elements = [];
    while (edge > limit) {
      element = lower ? element.previousChild : element.nextChild;
      elements.push(element);
      edge -= getSize(element)
    }
    return elements;
  }

  getSize(element) {
    let size = this.#sizes.get(element);
    return size === undefined ? getAverageSize() : size;
  }

  getAverageSize() {
    return DEFAULT_HEIGHT_ESTIMATE;
  }

  revealBoth(bounds) {
    let firstElement = this.firstChild;
    let elements = findElements(firstElement, 0, bounds.low, /* lower */ false);
    let startElement = elements ? elements[-1] : firstElement;
    let elementsToReveal = findElements(startElement, bounds.low, bounds.high, /* lower */ false);
    for (const element of elementsToReveal) {
      requestReveal(element);
    }
  }

  getScrollerHeight() {
    const numElements = this.children.length;
    return this.#totalMeasuredSize + (numElements - this.#measuredCount) * getAverageSize();
  }

  updateToOffset(offset) {
  }

  updateToElement(target) {
  }

  short(e) {
    return e.innerText.substr(0, 3);
  }

  #showElement = (e) => {
    /*
    this.#toShow.add(e);
    this.#toShow.add(e);
    this.#scheduleUpdate();
    */
  }

  #hideElement = (e) => {
    /*
    this.#toShow.add(e);
    this.#scheduleUpdate();
    e.setAttribute('invisible', '');
    e.displayLock.acquire({ timeout: Infinity, activatable: true });
    console.log("locking", this.short(e));
    if (this.#toShow.has(e)) {
      this.#toShow.remove(e);
    }
    */
  }

  #intersectionObserverCallback = (entries) => {
    /*
    for (const {target, isIntersecting} of entries) {
      // Update if the <virtual-content> has moved into or out of the viewport.
      if (target === this) {
        this.#scheduleUpdate();
        break;
      }

      const targetParent = target.parentNode;

      // Update if an empty space sentinel has moved into the viewport.
      if (targetParent === this.#emptySpaceSentinelContainer &&
          isIntersecting) {
        this.#scheduleUpdate();
        break;
      }

      // Update if a child has moved out of the viewport.
      if (targetParent === this && !isIntersecting) {
        this.#scheduleUpdate();
        break;
      }
    }
    */
  }

  #removeElement = (e) => {
    // Removed children should have be made visible again; they're no
    // longer under our control.
    this.#resizeObserver.unobserve(e);
    this.#intersectionObserver.unobserve(e);
    this.showElement(e);
    estimatedHeights.delete(e);
  }

  #addElement = (e) => {
    // Added children should be invisible initially. We want to make them
    // invisible at this MutationObserver timing, so that there is no
    // frame where the browser is asked to render all of the children
    // (which could be a lot).
    // [_update]() will remove invisible="" if it calculates that the
    // elements could be maybe in the viewport, at which point the
    // necessary ones will get rendered.
    this.hideElement(e);
  }

  mutationObserverCallback(records) {
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          this.#removeElement(node);
        }
      }

      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
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

//    this.#scheduleUpdate();
  }

  resizeObserverCallback() {
  }

  onActivateinvisible(e) {
  }

  scheduleUpdate() {
    if (this.#updateRAFToken !== undefined)
      return;

    this.#updateRAFToken = window.requestAnimationFrame(this.update);
  }

}
