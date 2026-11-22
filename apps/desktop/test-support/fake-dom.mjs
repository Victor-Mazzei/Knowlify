/**
 * Minimal browser surface for loading `bootstrap.js` in `node:test`. It models
 * only what the desktop connection screen touches; it is not a general DOM.
 */

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.required = false;
    this.tabIndex = 0;
    this.value = '';
    this.textContent = '';
    this.ownerDocument = null;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node && typeof node === 'object') node.parentNode = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.children) {
      if (child && typeof child === 'object') child.parentNode = null;
    }
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'hidden') this.hidden = true;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  dispatchEvent(event) {
    event.target ??= this;
    for (const handler of this.listeners.get(event.type) ?? []) handler(event);
    return !event.defaultPrevented;
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  closest() {
    return null;
  }
}

export function createDocument() {
  const document = {
    activeElement: null,
    listeners: new Map(),
    body: null,
    createElement(tagName) {
      const element = new FakeElement(tagName);
      element.ownerDocument = document;
      return element;
    },
    getElementById() {
      return null;
    },
    addEventListener(type, handler) {
      if (!document.listeners.has(type)) document.listeners.set(type, new Set());
      document.listeners.get(type).add(handler);
    },
  };
  document.body = document.createElement('body');
  return document;
}

/** Depth-first walk over the fake element tree, including text children. */
export function walk(root, visit) {
  visit(root);
  if (!root || typeof root !== 'object') return;
  for (const child of root.children) walk(child, visit);
}
