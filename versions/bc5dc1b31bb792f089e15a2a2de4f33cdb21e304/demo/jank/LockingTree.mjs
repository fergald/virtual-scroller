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
    this.slotPerChild = parseInt(this.getAttribute("slot-per-child"));
    if (this.slotPerChild) {
      this.groupSize = 1;
      this.branch = parseInt(this.getAttribute("branch")) || 10;
    } else {
      this.groupSize = parseInt(this.getAttribute("group-size")) || 10;
      this.branch = 2;
    }
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
    if (this.slotPerChild) {
      this.revealElementSlotPerChild(element);
    } else {
      this.revealElementAndSiblingsVisibleSlot(element);
    }
  }

  revealElementAndSiblingsVisibleSlot(element) {
    let slot = this.childToSlot.get(element);
    this.restoreVisibleElements();
    this.applyToAncestors(this.visibleSlot, (e) => {Locker.locker.lock(e)});
    slot.parentElement.insertBefore(this.visibleSlot, slot);
    this.applyToAncestors(this.visibleSlot, (e) => {Locker.locker.unlock(e)});
    this.makeElementsVisible(this.slotToChildren.get(slot));
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
    for (const e of this.revealed) {
      if (!newRevealed.has(e)) {
        e.style.display = "block";
        Locker.locker.lock(e);
      }
    }
    for (const e of newRevealed) {
      if (!this.revealed.has(e)) {
        e.style.display = "contents";
        Locker.locker.unlock(e);
      }
    }
    this.revealed = newRevealed;
  }

  applyToAncestors(slot, call) {
    let ancestors = new Set();
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
