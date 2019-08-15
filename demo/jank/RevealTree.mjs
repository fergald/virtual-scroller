'use strict';
const DEBUG = 1;

import * as Locker from '../util/Locker.mjs';

const TEMPLATE = `
<style>
div {
  display: block !important;
  contain: layout style;
}

div.revealed {
  display: contents;
  contain:;
}

slot.revealed {
  display: contents;
}
</style>
`;

class RevealTree extends HTMLElement {
  root;
  branch;
  revealed = new Set();
  childToSlot = new WeakMap();

  constructor() {
    super();
  }

  initShadowRoot() {
    const options = {mode: 'closed'};
    if (this.useISA) {
      options["slotting"] = "manual";
    }
    const shadowRoot = this.attachShadow(options);
    shadowRoot.innerHTML = TEMPLATE;
    this.root = document.createElement("div");
    this.root.id = "root";
    shadowRoot.appendChild(this.root);
  }

  populate() {
    this.slotPerChild = parseInt(this.getAttribute("slot-per-child"));
    this.branch = parseInt(this.getAttribute("branch")) || 10;
    this.useISA = parseInt(this.getAttribute("use-isa")) || 0;

    this.initShadowRoot();

    let slots = [];
    let slot;
    let i = 0;

    for (const child of this.children) {
      slot = document.createElement("slot");
      slots.push(slot);
      this.assign(slot, child, slots.length);
    }

    this.slots = slots;
    let tree = this.createTree(slots);
    this.tree = tree;
    if (tree) {
      this.root.appendChild(tree[0]);
      this.labelTree(tree[0], "d0");
    }
  }

  labelTree(tree, label) {
    if (tree == null) {
      return;
    }
    tree.id = label;
    for (let i = 0; i < tree.children.length; i++) {
      this.labelTree(tree.children[i], label + i);
    }
  }

  assign(slot, element, name) {
    this.childToSlot.set(element, slot);
    if (this.useISA) {
      slot.assign([element]);
    } else {
      element.slot = name;
      slot.name = name;
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
      for (let j = 0; j < this.branch && i < divs.length; j++) {
        div.appendChild(divs[i]);
        i++;
      }
      i--;
    }
    return newDivs;
  }

  findAncestorsForElements(elements, ancestors) {
    for (const element of elements) {
      this.findAncestorsForSlot(this.childToSlot.get(element), ancestors);
    }
  }

  findAncestorsForSlot(slot, ancestors) {
    let element = slot.parentElement;
    if (!element) {
      return;
    }
    while (element != this.root && !ancestors.has(element)) {
      ancestors.add(element);
      element = element.parentElement;
    }
  }

  revealElementAndSiblings(element) {
    this.revealElementSlotPerChild(element);
  }


  nextSiblings(element, count, direction, siblings) {
    while (element != null && count) {
      siblings.push(element);
      element = direction == -1 ? element.previousSibling : element.nextSibling;
      count--;
    }
  }

  revealElementSlotPerChild(element) {
    let elements = [element];
    this.nextSiblings(element.previousSibling, 5, -1, elements);
    this.nextSiblings(element.nextSibling, 5, +1, elements);
    let ancestors = new Set();
    this.findAncestorsForElements(elements, ancestors);
    this.updateRevealed(ancestors);
  }

  updateRevealed(newRevealed) {
    const revealed = [];
    for (const e of this.revealed) {
      if (!newRevealed.has(e)) {
        e.className = "";
        Locker.locker.lock(e);
        revealed.push(e);
      }
    }
    if (DEBUG) console.log("revealed", revealed);
    const hidden = [];
    for (const e of newRevealed) {
      if (!this.revealed.has(e)) {
        e.className = "revealed";
        Locker.locker.unlock(e);
      }
      hidden.push(e);
    }
    if (DEBUG) console.log("hidden", hidden);
    this.revealed = newRevealed;
  }
}

customElements.define('reveal-tree', RevealTree);
