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
<div id="emptySpaceSentinelContainer"></div>
<slot></slot>
`;

const _intersectionObserver = Symbol('_intersectionObserver');
const _mutationObserver = Symbol('_mutationObserver');
const _resizeObserver = Symbol('_resizeObserver');
const _cachedHeights = Symbol('_estimatedHeights');
const _updateRAFToken = Symbol('_updateRAFToken');
const _emptySpaceSentinelContainer = Symbol('_emptySpaceSentinelContainer');
const _showElement = Symbol('_showElement');
const _hideElement = Symbol('_hideElement');

const _intersectionObserverCallback = Symbol('_intersectionObserverCallback');
const _mutationObserverCallback = Symbol('_mutationObserverCallback');
const _resizeObserverCallback = Symbol('_resizeObserverCallback');
const _onActivateinvisible = Symbol('_onActivateinvisible');
const _scheduleUpdate = Symbol('_scheduleUpdate');
const _update = Symbol('_update');
const _toShow = Symbol('_toShow');

export class VirtualContent extends HTMLElement {
  constructor() {
    super();

    [_intersectionObserverCallback,
     _mutationObserverCallback,
     _resizeObserverCallback,
     _onActivateinvisible,
     _scheduleUpdate,
     _update,
     _showElement,
     _hideElement,
    ].forEach(x => this[x] = this[x].bind(this));

    const shadowRoot = this.attachShadow({mode: 'closed'});

    shadowRoot.innerHTML = TEMPLATE;

    this.#intersectionObserver =
        new IntersectionObserver(this.#intersectionObserverCallback);
    this.#mutationObserver =
        new MutationObserver(this.#mutationObserverCallback);
    this.#resizeObserver = new ResizeObserver(this.#resizeObserverCallback);
    this.#cachedHeights = new WeakMap();
    this.#updateRAFToken = undefined;
    this.#emptySpaceSentinelContainer =
        shadowRoot.getElementById('emptySpaceSentinelContainer');
    this.#toShow = new Set();
    this.#intersectionObserver.observe(this);
    // Send a MutationRecord-like object with the current, complete list of
    // child nodes to the MutationObserver callback; these nodes would not
    // otherwise be seen by the observer.
    this.#mutationObserverCallback([{
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
        'activateinvisible', this.#onActivateinvisible, {capture: true});
  }

  ["short"](e) {
    return e.innerText.substr(0, 3);
  }

  #showElement = (e) => {
    this.#toShow.add(e);
    window.requestAnimationFrame(() => {
      for (const e of this.#toShow) {
        e.removeAttribute('invisible');
        e.displayLock.commit();
        console.log("unlocking", this.short(e));
      }
      this.#toShow.clear();
    });
  }

  #hideElement = (e) => {
    e.setAttribute('invisible', '');
    e.displayLock.acquire({ timeout: Infinity, activatable: true });
    console.log("locking", this.short(e));
    if (this.#toShow.has(e)) {
      this.#toShow.remove(e);
    }
  }

  #intersectionObserverCallback = (entries) => {
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
  }

  #mutationObserverCallback = (records) => {
    const estimatedHeights = this.#cachedHeights;

    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Removed children should have be made visible again; they're no
          // longer under our control.
          this.#resizeObserver.unobserve(node);
          this.#intersectionObserver.unobserve(node);
          this.#showElement(node);
          estimatedHeights.delete(node);
        }
      }

      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Added children should be invisible initially. We want to make them
          // invisible at this MutationObserver timing, so that there is no
          // frame where the browser is asked to render all of the children
          // (which could be a lot).
          // [_update]() will remove invisible="" if it calculates that the
          // elements could be maybe in the viewport, at which point the
          // necessary ones will get rendered.
          this.#hideElement(node);
          estimatedHeights.set(node, DEFAULT_HEIGHT_ESTIMATE);
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

    this.#scheduleUpdate();
  }

  #resizeObserverCallback = () => {
    this.#scheduleUpdate();
  }

  #onActivateinvisible = (e) => {
    // Find the child containing the target and synchronously update, forcing
    // that child to be visible. The browser will automatically scroll to that
    // element because it is visible, which will trigger another update to make
    // the surrounding nodes visible.
    let child = e.target;
    while (child.parentNode !== this) {
      child = child.parentNode;
    }
    this.#update(child);
  }

  #scheduleUpdate = () => {
    if (this.#updateRAFToken !== undefined)
      return;

    this.#updateRAFToken = window.requestAnimationFrame(this.#update);
  }

  // TODO: this method is enormous. Split it up into several separate steps.
  // https://refactoring.guru/smells/long-method
  #update = (childToForceVisible) => {
    this.#updateRAFToken = undefined;

    const thisClientRect = this.getBoundingClientRect();
    // Don't read or store layout information if the <virtual-content> isn't in
    // a renderable state (e.g. disconnected, invisible, `display: none`, etc.).
    const isRenderable = thisClientRect.top !== 0 ||
        thisClientRect.left !== 0 || thisClientRect.width !== 0 ||
        thisClientRect.height !== 0;

    const cachedHeights = this.#cachedHeights;
    const getAndCacheHeightIfPossible = (child) => {
      if (isRenderable && !child.hasAttribute('invisible')) {
        const childClientRect = child.getBoundingClientRect();
        const style = window.getComputedStyle(child);
        const height = window.parseFloat(style.marginTop, 10) +
            window.parseFloat(style.marginBottom, 10) + childClientRect.height;
        cachedHeights.set(child, height);
      }
      return cachedHeights.get(child);
    };

    const previouslyVisible = new Set();
    for (let child = this.firstChild; child !== null;
         child = child.nextSibling) {
      if (!child.hasAttribute('invisible')) {
        previouslyVisible.add(child);
      }
    }

    let beforePreviouslyVisible = previouslyVisible.size > 0;
    let nextTop = 0;
    let renderedHeight = 0;

    // The estimated height of all elements made invisible since the last time
    // an element was made visible (or start of the child list).
    let currentInvisibleRunHeight = 0;
    // The next empty space sentinel that should be reused, if any.
    let nextEmptySpaceSentinel = this.#emptySpaceSentinelContainer.firstChild;
    // Inserts an empty space sentinel representing the last contiguous run of
    // invisible elements. Reuses already existing empty space sentinels, if
    // possible.
    const insertEmptySpaceSentinelIfNeeded = () => {
      if (currentInvisibleRunHeight > 0) {
        let sentinel = nextEmptySpaceSentinel;
        if (nextEmptySpaceSentinel === null) {
          sentinel = document.createElement('div');
          this.#emptySpaceSentinelContainer.appendChild(sentinel);
        }
        nextEmptySpaceSentinel = sentinel.nextSibling;

        const sentinelStyle = sentinel.style;
        console.log(`sentinel top ${nextTop - currentInvisibleRunHeight}`);
        sentinelStyle.top = `${nextTop - currentInvisibleRunHeight}px`;
        console.log(`sentinel height ${currentInvisibleRunHeight}px`);
        sentinelStyle.height = `${currentInvisibleRunHeight}px`,

        this.#intersectionObserver.observe(sentinel);

        currentInvisibleRunHeight = 0;
      }
    };

    for (let child = this.firstChild; child !== null;
         child = child.nextSibling) {
      if (beforePreviouslyVisible && previouslyVisible.has(child)) {
        beforePreviouslyVisible = false;
      }

      // At this point the element might not be rendered, so this either gets
      // the current height (if rendered) or the last known, possibly
      // inaccurate, height.
      let possiblyCachedHeight = getAndCacheHeightIfPossible(child);

      const childClientTop = thisClientRect.top + nextTop;

      // This is based on the height above, so it might not be correct.
      // If it turns out to be true, then we make the element visible and read
      // its height more exactly.
      const maybeInViewport = (0 <= childClientTop + possiblyCachedHeight) &&
          (childClientTop <= window.innerHeight);

      if (maybeInViewport || child === childToForceVisible) {
        if (child.hasAttribute('invisible')) {
          this.#showElement(child);
          this.#resizeObserver.observe(child);
          this.#intersectionObserver.observe(child);

          // Since we just flipped to be visible, we should recalculate the
          // height and update the cache.
          const previousCachedHeight = possiblyCachedHeight;
          possiblyCachedHeight = getAndCacheHeightIfPossible(child);

          if (beforePreviouslyVisible) {
            const scrollingAncestor = nearestScrollingAncestor(this);
            if (scrollingAncestor !== null) {
              scrollingAncestor.scrollBy(
                  0, possiblyCachedHeight - previousCachedHeight);
            }
          }
        }

        // At this point possiblyCachedHeight is exact, so we can use the same
        // technique as we did when calculating maybeInViewport, but this time
        // we will have a guaranteed-correct answer.
        const isInViewport = (0 <= childClientTop + possiblyCachedHeight) &&
            (childClientTop <= window.innerHeight);

        console.log(`nextTop ${nextTop}`, this.short(child));
        if (isInViewport || child === childToForceVisible) {
          insertEmptySpaceSentinelIfNeeded();

          console.log(`setting top ${nextTop}`, this.short(child));
          child.style.top = `${nextTop - renderedHeight}px`;
          renderedHeight += possiblyCachedHeight;
        } else {
          this.#hideElement(child);
          this.#resizeObserver.unobserve(child);
          this.#intersectionObserver.unobserve(child);

          currentInvisibleRunHeight += possiblyCachedHeight;
        }
      } else {
        if (!child.hasAttribute('invisible')) {
          this.#hideElement(child);
          this.#resizeObserver.unobserve(child);
          this.#intersectionObserver.unobserve(child);
        }

        currentInvisibleRunHeight += possiblyCachedHeight;
      }

      nextTop += possiblyCachedHeight;
    }

    insertEmptySpaceSentinelIfNeeded();

    // Remove any extra empty space sentinels.
    while (nextEmptySpaceSentinel !== null) {
      const sentinel = nextEmptySpaceSentinel;
      nextEmptySpaceSentinel = sentinel.nextSibling;

      this.#intersectionObserver.unobserve(sentinel);
      sentinel.remove();
    }

    this.style.height = `${nextTop}px`;
  }
}
