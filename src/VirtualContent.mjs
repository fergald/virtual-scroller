const DEBUG = true;
const BUFFER = .2;

let LOCKING = true;
let COLOUR = !LOCKING || true;

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
  display: block;
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
  contain: layout style
}

#outerContainer {
  contain: layout style;
}

#innerContainer {
  overflow-y: scroll;
  height: 500px;
}
</style>
<div id="outerContainer">
  <div id="innerContainer">
    <div id="emptySpaceSentinelContainer"></div>
    <slot></slot>
  </div>
</div>
`;

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
}

const LOCK_STATE_ACQUIRING = Symbol("LOCK_STATE_ACQUIRING");
const LOCK_STATE_ACQUIRED = Symbol("LOCK_STATE_ACQUIRED");
const LOCK_STATE_COMMITTING = Symbol("LOCK_STATE_COMMITTING");
//const LOCK_STATE_COMMITTED = Symbol("LOCK_STATE_COMMITTED");

export class VirtualContent extends HTMLElement {
  sizes = new WeakMap();
  target;
  toShow = new Set();
  updateRAFToken;
  postUpdateNeeded = false;
  intersectionObserver;
  mutationObserver;
  resizeObserver;
  // The inner container allows us to get the size of the scroller without
  // forcing layout of the containing doc.
  outerContainer;
  innerContainer;
  emptySpaceSentinelContainer;

  innerRect;
  scrollerBounds;
  revealedBounds;
  attemptedRevealedBounds;

  lockState = new WeakMap();
  toUnlock = new Set();
  justUnlocked = new Set();

  elements = new WeakSet();
  locking = new Set();
  unlocking = new Set();

  totalMeasuredSize = 0;
  measuredCount = 0;

  empty = true;
  revealed = new WeakSet();

  constructor() {
    super();

    if (!this.displayLock) {
      console.log("Disabling locking");
      LOCKING = false;
      COLOUR = true;
    }
    const shadowRoot = this.attachShadow({mode: 'closed'});
    shadowRoot.innerHTML = TEMPLATE;
    this.emptySpaceSentinelContainer =
        shadowRoot.getElementById('emptySpaceSentinelContainer');
    this.outerContainer =
        shadowRoot.getElementById('outerContainer');
    this.innerContainer =
      shadowRoot.getElementById('innerContainer');
    this.innerRect = this.innerContainer.getBoundingClientRect()

    this.intersectionObserver =
        new IntersectionObserver(this.intersectionObserverCallback);

    this.mutationObserver = new MutationObserver((records) => {this.mutationObserverCallback(records)});
    this.resizeObserver = new ResizeObserver(this.resizeObserverCallback);
    this.intersectionObserver.observe(this);

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
    this.mutationObserver.observe(this, {childList: true});

    // `capture: true` helps support the nested <virtual-content> case. (Which
    // is not yet officially supported, but we're trying.) In particular, this
    // ensures that the events handlers happen from outermost <virtual-content>
    // inward, so that we remove invisible="" from the outside in. Then, by the
    // time we get to the innermost node, all of its parents are no longer
    // invisible="", and thus it will be rendered (allowing us to accurately
    // measure its height, etc.)
    this.addEventListener(
        'activateinvisible', this.onActivateinvisible, {capture: true});

    this.innerContainer.addEventListener('scroll', (e) => {
      this.scheduleUpdate();
    });
      
    this.scheduleUpdate();
  }

  setTarget(offset) {
    this.target = offset;
    this.scheduleUpdate();
  }

  _hideBounds(bounds) {
    let element = bounds.lowElement;
    while (true) {
      this.requestHide(element);
      element = element.nextElementSibling;
      if (!element) {
        break;
      }
    }
  }
  
  sync() {
    console.log("sync");

    if (this.childNodes.length == 0) {
      return;
    }

    const desiredBounds = this.getDesiredBounds();

    let newRevealedBounds;
    if (this.revealedBounds !== undefined) {
      if (desiredBounds.overlaps(this.revealedBounds)) {
        newRevealedBounds = this.revealedBounds;
      } else {
        this.hideBounds(this.revealedBounds);
      }
    }

    if (newRevealedBounds === undefined) {
      newRevealedBounds = this.revealFirstChild(desiredBounds);
    }

    console.log("newRevealedBounds", newRevealedBounds);
    console.log("desiredBounds", desiredBounds);
    this.revealedBounds = this.syncBounds(newRevealedBounds, desiredBounds);
  }

  syncBounds(revealedBounds, desiredBounds) {
    revealedBounds = revealedBounds.low < desiredBounds.low ?
      this.hideDirection(revealedBounds, desiredBounds, /* lower */ false) :
      this.revealDirection(revealedBounds, desiredBounds, /* lower */ true);
    console.log("revealedBounds", revealedBounds);
    revealedBounds = revealedBounds.high > desiredBounds.high ?
      this.hideDirection(revealedBounds, desiredBounds, /* lower */ true) :
      this.revealDirection(revealedBounds, desiredBounds, /* lower */ false);
    console.log("revealedBounds", revealedBounds);

    return revealedBounds;
  }
  
  measure(element) {
    let oldSize = this.sizes.get(element);
    if (oldSize === undefined) {
      oldSize = 0;
      this.measuredCount++;
    }
    let newSize = element.offsetHeight;
    this.totalMeasuredSize += newSize - oldSize;
    this.sizes.set(element, newSize);
  }

  getScrollerHeight() {
    if (this.scrollerHeight === undefined) {
      let rect = this.getBoundingClientRect();
      this.scrollerHeight = rect.height;
    }
    return this.scrollerHeight;
  }

  getScrollerBounds() {
    return new Range(this.innerContainer.scrollTop, this.innerContainer.scrollTop + this.getScrollerHeight());
  }

  getDesiredBounds() {
    const top = this.innerContainer.scrollTop;
    const height = this.getScrollerHeight();
    return new Range(Math.max(0, top - BUFFER * height), Math.min(top + height + BUFFER * height, this.innerContainer.scrollHeight));
  }

  revealFirstChild(bounds) {
    let priorSize = 0;
    let child = this.firstChild;
    let size;
    while (true)  {
      size = this.getSize(child);
      if (priorSize >= bounds.low) {
        break;
      }
      priorSize += size;
      child = child.nextElementSibling;
    }
    this.requestReveal(child);
    return new Range(priorSize, priorSize + this.getSize(child), child, child);
  }

  tryRevealBounds(bounds) {
    if (bounds.lowElement) {
      return this.revealDirection(bounds, /* lower */ false);
    } else if (bounds.highElement) {
      return this.revealDirection(bounds, /* lower */ true);
    } else {
      //return this.revealBoth(bounds);
      throw "Can't be neither"
    }
  }

  tryHideBounds(bounds) {
    if (bounds.lowElement) {
      return this.hideDirection(bounds, /* lower */ false);
    } else if (bounds.highElement) {
      return this.hideDirection(bounds, /* lower */ true);
    } else {
      throw "Can't be neither"
    }
  }

  getRevealed(element) {
    return LOCKING ?
      !element.displayLock.locked :
      element.style.color != "red";
  }

  reveal(element) {
    this.revealed.add(element);
    if (COLOUR) {
      element.style.color = "green";
    }
    if (LOCKING) {
      element.displayLock.commit();
    }
    this.measure(element);
  }

  hide(element) {
    this.revealed.delete(element);
    if (COLOUR) {
      element.style.color = "red";
    }
    if (LOCKING) {
      element.displayLock.acquire({ timeout: Infinity, activatable: true });
    }
  }

  requestReveal(element) {
    if (this.getRevealed(element)) {
      console.log(element, "is already unlocked");
    } else {
      this.reveal(element);
    }
  }

  requestHide(element) {
    if (!this.getRevealed(element)) {
      console.log(element, "is already locked");
    } else {
      this.hide(element);
    }
  }

  nextElement(element, lower) {
    return lower ? element.previousElementSibling : element.nextElementSibling;
  }

  range(lowElement, highElement) {
    return new Range(this.getOffset(lowElement), this.getOffset(highElement) + highElement.offsetHeight,
                     lowElement, highElement);
  }

  revealDirection(bounds, limitBounds, lower) {
    let startElement = lower ? bounds.lowElement : bounds.highElement;
    let pixelsNeeded = lower ? bounds.low - limitBounds.low : limitBounds.high - bounds.high;
    let element = startElement;
    while (pixelsNeeded > 0) {
      console.log("element", element);
      let nextElement = this.nextElement(element, lower);
      if (!nextElement) {
        break;
      }
      element = nextElement;
      this.requestReveal(element);
      pixelsNeeded -= this.getSize(element);
    }
    if (element === startElement) {
      return bounds;
    }
    return lower ?
      this.range(element, bounds.highElement) :
      this.range(bounds.lowElement, element);
  }

  hideDirection(bounds, limitBounds, lower) {
    let startElement = lower ? bounds.highElement : bounds.lowElement;
    let pixelsNeeded = lower ? bounds.high - limitBounds.high : limitBounds.low - bounds.low;
    let element = startElement;
    while (true) {
      let nextElement = this.nextElement(element, lower);
      if (!nextElement) {
        break;
      }
      pixelsNeeded -= this.getSize(element);
      if (pixelsNeeded <= 0) {
        break;
      }
      this.requestHide(element);
      element = nextElement;
    }
    if (element == startElement) {
      return bounds;
    }
    return lower ?
      this.range(bounds.lowElement, element) :
      this.range(element, bounds.highElement);
  }

  getOffset(element) {
    return element.offsetTop - this.offsetTop;
  }
  
  findElements(element, pixelsNeeded, lower) {
    console.log("element", element);
    let elements = [];
    while (pixelsNeeded > 0) {
      elements.push(element);
      pixelsNeeded -= this.getSize(element)
      element = lower ? element.previousElementSibling : element.nextElementSibling;
      console.log("element", element);
      console.log("pixelsNeeded", pixelsNeeded);
    }
    return elements;
  }

  getSize(element) {
    let size = this.sizes.get(element);
    return size === undefined ? this.getAverageSize() : size;
  }

  getAverageSize() {
    return DEFAULT_HEIGHT_ESTIMATE;
  }

  revealBoth(bounds) {
    let firstElement = this.firstChild;
    let elements = this.findElements(firstElement, bounds.low, /* lower */ false);
    let startElement = elements ? elements[-1] : firstElement;
    let elementsToReveal = this.findElements(startElement, bounds.getSize(), /* lower */ false);
    for (const element of elementsToReveal) {
      this.requestReveal(element);
    }
  }

  getContentHeight() {
    const numElements = this.children.length;
    return this.totalMeasuredSize + (numElements - this.measuredCount) * getAverageSize();
  }

  updateToOffset(offset) {
  }

  updateToElement(target) {
  }

  short(e) {
    return e.innerText.substr(0, 3);
  }

  showElement = (e) => {
    /*
    this.toShow.add(e);
    this.toShow.add(e);
    this.scheduleUpdate();
    */
  }

  intersectionObserverCallback = (entries) => {
    /*
    for (const {target, isIntersecting} of entries) {
      // Update if the <virtual-content> has moved into or out of the viewport.
      if (target === this) {
        this.scheduleUpdate();
        break;
      }

      const targetParent = target.parentNode;

      // Update if an empty space sentinel has moved into the viewport.
      if (targetParent === this.emptySpaceSentinelContainer &&
          isIntersecting) {
        this.scheduleUpdate();
        break;
      }

      // Update if a child has moved out of the viewport.
      if (targetParent === this && !isIntersecting) {
        this.scheduleUpdate();
        break;
      }
    }
    */
  }

  unlockElement(element) {
    const state = this.lockState.get(element);
    if (state === LOCK_STATE_ACQUIRED) {
      this.lockState.set(element, LOCK_STATE_COMMITTING);
      this.unlocking.add(element);
      return element.displayLock.updateAndCommit().then(
          () => {
            this.lockState.delete(element);
            this.unlocking.delete(element);
            if (this.elements.has(element)) {
              this.justUnlocked.add(element);
              this.scheduleUpdate();
            }
          });
    } else {
      DLOG(element, "while unlocking lock state", state);
    }
  }

  removeElement(element) {
    // Removed children should have be made visible again. We stop observing
    // them for resize so we should discard any size info we have to them as it
    // may become incorrect.
    this.resizeObserver.unobserve(element);
    this.unlockElement(element);
    this.sizes.delete(element);
    this.elements.delete(element);
  }

  lockElement(element) {
    const state = this.lockState.get(element);
    if (state === undefined) {
      this.lockState.set(element, LOCK_STATE_ACQUIRING);
      this.locking.add(element);
      console.log("acquiring", element);
      return element.displayLock.acquire({ timeout: Infinity, activatable: true }).then(
          () => {
            // console.log("acquired", element);
            // console.log("locked", element.displayLock.locked);
            this.lockState.set(element, LOCK_STATE_ACQUIRED);
            this.locking.delete(element);
            if (this.elements.has(element)) {
              this.scheduleUpdate();
            }
          });
    } else {
      DLOG(element, "while locking lock state", state);
    }
  }

  addElement(element) {
    // Added children should be invisible initially. We want to make them
    // invisible at this MutationObserver timing, so that there is no
    // frame where the browser is asked to render all of the children
    // (which could be a lot).
    this.elements.add(element);
    this.resizeObserver.observe(element);
    return this.requestHide(element);
  }

  mutationObserverCallback(records) {
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

  resizeObserverCallback() {
  }

  onActivateinvisible(e) {
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
