'use strict';

import * as Locker from '../util/Locker.mjs';

const TEMPLATE = `
<style>
:host {
  /* Browsers will automatically change the scroll position after we modify the
   * DOM, unless we turn it off with this property. We want to do the adjustments
   * ourselves in [_update](), instead. */
  overflow-anchor: none;
  display: block;
}

div {
  display: block !important;
  contain: layout style
}

</style>
`;

class LockingTree extends HTMLElement {
  groupSize;
  revealed = new Set();
  childToSlot = new WeakMap();

  root;
  visibleSlot;

  constructor() {
    super();
    const shadowRoot = this.attachShadow({mode: 'closed'});
    shadowRoot.innerHTML = TEMPLATE;
    this.groupSize = this.getAttribute("group-size") || 10;
    this.root = document.createElement("div");
    this.root.id = "root";
    shadowRoot.appendChild(this.root);
    this.visibleSlot = document.createElement("slot");
    this.populate();
  }

  populate() {
    let elementCount = this.children.length;

    let slots = [];
    let slot;
    let i = 0;

    for (const child of this.children) {
      if (i % this.groupSize == 0) {
        slot = document.createElement("slot");
        slots.push(slot);
        slot.name = slots.length;
      }
      this.childToSlot.set(child, slot);
      child.slot = slot.name;
      i++;
    }

    this.slots = slots;
    this.root.innerHTML = "";
    let tree = this.createTree(slots);
    this.tree = tree;
    if (tree) {
      this.root.appendChild(tree[0]);
    }
  }

  createTree(slots) {
    if (slots.length == 0) {
      return null;
    }

    let divLayer = this.createLeafDivLayer(slots);
    while (true) {
      divLayer = this.createDivLayer(divLayer);
      if (divLayer.length == 1) {
        return divLayer;
      }
    }
  }

  createLeafDivLayer(slots) {
    let divs = [];
    for (const slot of slots) {
      let div = document.createElement("div");
      divs.push(div);
      div.appendChild(slot);
      Locker.locker.lock(div);
    }
    return divs;
  }

  createDivLayer(divs) {
    let newDivs = [];
    for (let i = 0; i < divs.length; i++) {
      let div = document.createElement("div");
      Locker.locker.lock(div);
      newDivs.push(div);
      div.appendChild(divs[i]);
      i++;
      if (i < divs.length) {
        div.appendChild(divs[i]);
      }
    }
    return newDivs;
  }

  findAncestorsForElement(element, elements) {
    findAncestorsForSlot(this.childToSlot.get(element));
  }

  findAncestorsForSlot(slot, elements) {
    let element = slot.parentElement;
    if (!element) {
      return;
    }
    while (element != this.root) {
      elements.push(element);
      element = element.parentElement;
    }
  }

  revealElementAndSiblings(element) {
    let slot = this.childToSlot.get(element);
    this.restoreVisibleElements();
    this.applyToAncestors(this.visibleSlot, (e) => {Locker.locker.lock(e)});
    slot.parentElement.insertBefore(this.visibleSlot, slot);
    this.applyToAncestors(this.visibleSlot, (e) => {Locker.locker.unlock(e)});
    this.makeElementsVisible(slot.assignedNodes());
  }

  applyToAncestors(slot, call) {
    let ancestors = [];
    this.findAncestorsForSlot(slot, ancestors);
    for (const a of ancestors) {
      call(a);
    }
  }

  makeElementsVisible(elements) {
    for (const e of elements) {
      e.slot = this.visibleSlot.name;
    }
  }

  restoreVisibleElements() {
    this.restoreElementsToNaturalSlot(this.visibleSlot.assignedNodes());
  }

  restoreElementsToNaturalSlot(elements) {
    for (const e of elements) {
      e.slot = this.childToSlot.get(e).name;
    }
  }

  revealLeaf(leafs) {
    let elements = new Set();
    for (const leaf of leafs) {
      this.findForNode(leaf, elements);
    }
    this.setRevealed(elements);
  }

  setRevealed(newRevealed) {
    let locked = new Set();
    let unlocked = new Set();
    console.time("unlock")
    for (const e of newRevealed) {
      if (this.revealed.has(e)) {
        this.revealed.delete(e);
      } else {
        this.unlock(e);
        unlocked.add(e)
      }
    }
    console.timeEnd("unlock")
    console.time("lock")
    for (const e of this.revealed) {
      this.lock(e);
      locked.add(e)
    }
    console.timeEnd("lock")
    this.revealed = newRevealed;
    console.log("setRevealed");
      console.log("locked", locked);
      console.log("unlocked", unlocked);
  }

  update() {
    for (let e of this.leaves) {
      e.displayLock.update();
    }
  }
}

customElements.define('locking-tree', LockingTree);
