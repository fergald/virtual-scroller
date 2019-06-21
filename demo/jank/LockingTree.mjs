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

  // Ideally we would just use slot.assignedNodes but until
  // https://crbug.com/968928 is fixed, this works around that.
  slotToChildren = new WeakMap();
  visibleNodes = [];

  root;
  visibleSlot;

  constructor() {
    super();
    const shadowRoot = this.attachShadow({mode: 'closed'});
    shadowRoot.innerHTML = TEMPLATE;
    this.root = document.createElement("div");
    this.root.id = "root";
    shadowRoot.appendChild(this.root);
    this.visibleSlot = document.createElement("slot");
    this.populate();
  }

  populate() {
    this.groupSize = parseInt(this.getAttribute("group-size")) || 10;
    this.useISA = parseInt(this.getAttribute("use-isa"));

    let slots = [];
    let slot;
    let i = 0;

    for (const child of this.children) {
      if (i % this.groupSize == 0) {
        slot = document.createElement("slot");
        this.slotToChildren.set(slot, []);
        slots.push(slot);
        slot.name = slots.length;
      }
      this.childToSlot.set(child, slot);
      this.assign(slot, [child]);
      this.slotToChildren.get(slot).push(child);
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

  assign(slot, elements) {
    if (this.useISA) {
      slot.assign(elements);
    } else {
      for (const e of elements) {
        e.slot = slot.name;
      }
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
    this.makeElementsVisible(this.slotToChildren.get(slot));
  }

  applyToAncestors(slot, call) {
    let ancestors = [];
    this.findAncestorsForSlot(slot, ancestors);
    for (const a of ancestors) {
      call(a);
    }
  }

  makeElementsVisible(elements) {
    this.visibleNodes = elements;
    this.assign(this.visibleSlot, elements);
  }

  restoreVisibleElements() {
    this.restoreElementsToNaturalSlot(this.visibleNodes);
  }

  // Assume all elements have the same natural slot. OK for demo.
  restoreElementsToNaturalSlot(elements) {
    if (elements.length == 0) {
      return;
    }
    this.assign(this.childToSlot.get(elements[0]), elements);
  }
}

customElements.define('locking-tree', LockingTree);
