import { LitElement, html, css } from 'lit';

export function loadMDCustomElements() {
  return import('@material/web/all').catch((err) => {
    console.warn('Failed to load @material/web components:', err);
  });
}

export { LitElement, html, css };
