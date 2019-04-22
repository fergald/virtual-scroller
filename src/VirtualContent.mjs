const DEBUG = true;
const BUFFER = .2;

let LOCKING_DEFAULT = true;
let COLOUR_DEFAULT = false;

function DLOG(...messages) {
  if (!DEBUG) {
    return;
  }
  console.log(...messages);
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

const LOCK_STATE_ACQUIRING = Symbol("LOCK_STATE_ACQUIRING");
const LOCK_STATE_ACQUIRED = Symbol("LOCK_STATE_ACQUIRED");
const LOCK_STATE_COMMITTING = Symbol("LOCK_STATE_COMMITTING");
//const LOCK_STATE_COMMITTED = Symbol("LOCK_STATE_COMMITTED");

export class VirtualContent extends HTMLElement {
  sizes = new WeakMap();
  sizeValid = new WeakMap();
  updateRAFToken;
  intersectionObserver;
  mutationObserver;
  resizeObserver;
  innerContainer;
  emptySpaceSentinelContainer;

  revealedBounds;

  totalMeasuredSize = 0;
  measuredCount = 0;

  revealed = new Set();

  useLocking;
  useColor = true;

  constructor() {
    super();

    this.setUseLocking(LOCKING_DEFAULT);

    const shadowRoot = this.attachShadow({mode: 'closed'});
    shadowRoot.innerHTML = TEMPLATE;
    this.emptySpaceSentinelContainer =
        shadowRoot.getElementById('emptySpaceSentinelContainer');
    this.innerContainer =
      shadowRoot.getElementById('innerContainer');

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

  setUseLocking(useLocking) {
    if (useLocking && !this.displayLock) {
      console.log("Disabling locking");
      this.useLocking = false;
    } else {
      this.useLocking = useLocking;
    }
  }

  sync() {
    let start = performance.now();
    console.log("sync");

    if (this.childNodes.length == 0) {
      return;
    }

    let windowBounds = new Range(0, window.innerHeight);
    let newRevealedBounds = this.revealBounds(windowBounds);
    console.log("newRevealedBounds", newRevealedBounds);
    newRevealedBounds = this.trimRevealed(newRevealedBounds, windowBounds);
    let newRevealed = newRevealedBounds.elementSet();
    console.log("newRevealedBounds after trim", newRevealedBounds);
    let toHide = this.setDifference(this.revealed, newRevealed);
    console.log("toHide", toHide);
    this.setDifference(this.revealed, newRevealed).forEach(e => this.requestHide(e));
    // console.log("revealCount", this.revealCount());

    let end = performance.now();
    console.log("sync took: " + (end - start));
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
    if (DEBUG) {
      let count = 0;
      for (const element of this.children) {
        if (this.getRevealed(element)) {
          count++;
        }
      }
      if (count != this.revealed.size) {
        throw "count != this.revealed: " + count + ", " + this.revealed.size;
      }
    }
    return this.revealed.size;
  }

  findElement(offset, bias) {
    let low = 0;
    let high = this.children.length - 1;
    let i;
    while (low < high) {
      i = Math.floor((low + high)/2);
      let element = this.children[i];
      let rect = element.getBoundingClientRect()
      if (rect.top > offset) {
        high = i - 1;
      } else if (rect.bottom < offset) {
        low = i + 1;
      } else {
        break;
      }
    }
    return this.children[bias < 0 ? low : high];
  }

  revealHopefulBounds(bounds) {
    let lowElement = this.findElement(bounds.low, /* bias= */ -1);
    let highElement = this.findElement(bounds.high, /* bias= */ 1);

    return this.range(lowElement, highElement);
  }
  
  revealBounds(bounds) {
    let previous;
    while (true) {
      let reveal = this.revealHopefulBounds(bounds);
      if (previous && reveal.sameEnds(previous)) {
        return reveal;
      }
      previous = reveal;
      this.ensureRevealed(reveal);
    }
  }

  ensureRevealed(bounds) {
    bounds.doToAll(e => {
      if (!this.getRevealed(e)) {
        this.reveal(e);
      }
    });
  }

  trimRevealed(bounds, limit) {
    let low, high;
    bounds.doToAll(e => {
      let rect = e.getBoundingClientRect();
      if (rect.bottom < limit.low || rect.top > limit.high) {
        this.requestHide(e);
      } else {
        if (!low) {
          low = e;
        }
        high = e;
      }
    });
    return this.range(low, high);
  }

  ensureValidSize(element) {
    if (this.sizeValid.get(element)) {
      if (DEBUG) {
        if (this.sizes.has(element) === undefined) {
          throw "No size for valid size: " + element;
        }
      }
      return;
    }
    if (!this.getRevealed()) {
      throw "Called ensureValidSize on locked element " + element;
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

  invalidateSize(element) {
    this.sizeValid.set(element, false);
  }

  measureBounds(bounds) {
    bounds.doToAll(element => {this.ensureValidSize(element)});
  }

  getRevealed(element) {
    if (this.useLocking) {
      return !element.displayLock.locked
    } else if (this.useColor) {
      return element.style.color != "red";
    } else {
      return this.revealed.has(element);
    }
  }

  reveal(element) {
    this.revealed.add(element);
    if (this.useColor) {
      element.style.color = "green";
    }
    if (this.useLocking) {
      element.displayLock.commit().then(null, reason => {console.log("Rejected: ", reason)});
    }
  }

  hide(element) {
    this.revealed.delete(element);
    if (this.useColor) {
      element.style.color = "red";
    }
    if (this.useLocking) {
      element.displayLock.acquire({
        timeout: Infinity,
        activatable: true,
        size: [10, this.getHopefulSize(element)],
      }).then(null, reason => {console.log("Rejected: ", reason.message)});
    }
    this.invalidateSize(element);
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
      if (DEBUG) {
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

  getValidSize(element) {
    this.ensureValidSize(element);
    return this.sizes.get(element);
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

  removeElement(element) {
    // Removed children should have be made visible again. We stop observing
    // them for resize so we should discard any size info we have to them as it
    // may become incorrect.
    this.resizeObserver.unobserve(element);
    this.hide(element);
    this.sizes.delete(element);
  }

  addElement(element) {
    // Added children should be invisible initially. We want to make them
    // invisible at this MutationObserver timing, so that there is no
    // frame where the browser is asked to render all of the children
    // (which could be a lot).
    this.resizeObserver.observe(element);
    this.revealed.add(element);
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
