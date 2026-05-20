/**
 * subscription.js — Dawn AJAX add-to-cart compatible
 * Fixed: variant price update for Dawn 9+ variant-selects/variant-radios
 */

(function () {
  'use strict';

  // ── Global variant price cache ────────────────────────────────
  // Populated from window.KAS_PRODUCT_DATA injected by Liquid
  // Falls back to ShopifyAnalytics
  function getAllVariants() {
    if (window.KAS_PRODUCT_DATA?.variants) return window.KAS_PRODUCT_DATA.variants;
    if (window.ShopifyAnalytics?.meta?.product?.variants) {
      return window.ShopifyAnalytics.meta.product.variants;
    }
    // Last resort: parse from JSON in page
    try {
      const el = document.getElementById('product-json') || document.querySelector('[data-product-json]');
      if (el) return JSON.parse(el.textContent).variants;
    } catch(e) {}
    return [];
  }

  function getSelectedVariantId() {
    // Dawn 9+: variant-selects or variant-radios custom element
    const variantSelects = document.querySelector('variant-selects, variant-radios');
    if (variantSelects) {
      // Dawn stores current variant in the form's id input
      const idInput = document.querySelector('form[id*="product"] input[name="id"], #product-form input[name="id"]');
      if (idInput) return idInput.value;
    }
    // Fallback: select or checked radio
    const sel = document.querySelector('select[name="id"]');
    if (sel) return sel.value;
    const radio = document.querySelector('input[name="id"]:checked');
    if (radio) return radio.value;
    return null;
  }

  function getSelectedVariant() {
    const id       = getSelectedVariantId();
    const variants = getAllVariants();
    if (!id || !variants.length) return null;
    return variants.find(v => String(v.id) === String(id)) || null;
  }

  function init() {
    const widgets = document.querySelectorAll('.sub-widget');
    if (!widgets.length) return;
    widgets.forEach(initWidget);
  }

  function initWidget(widget) {
    const radios    = widget.querySelectorAll('.sub-option__radio');
    const cards     = widget.querySelectorAll('.sub-option');
    const savingsEl = widget.querySelector('.sub-widget__savings');
    if (!radios.length) return;

    radios.forEach((radio) => {
      if (radio.checked) {
        setActive(radio, cards, savingsEl);
        syncSellingPlan(radio.value);
      }
      radio.addEventListener('change', () => {
        setActive(radio, cards, savingsEl);
        updatePagePrice(radio);
        syncSellingPlan(radio.value);
      });
    });

    cards.forEach((card) => {
      card.setAttribute('tabindex', '0');
      card.setAttribute('role', 'radio');
      card.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          const radio = card.querySelector('.sub-option__radio');
          if (radio) {
            radio.checked = true;
            radio.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      });
    });

    // ── Listen for ALL variant change patterns ─────────────────

    // 1. Custom event from Dawn or other themes
    document.addEventListener('variant:change', (e) => {
      updatePricesFromVariant(widget, e.detail?.variant);
    });

    // 2. Dawn 9+ theme:variant:change
    document.addEventListener('theme:variant:change', (e) => {
      updatePricesFromVariant(widget, e.detail?.variant);
    });

    // 3. Dawn 9+ variant-selects / variant-radios custom element
    //    These fire a native 'change' event on themselves
    const variantComponent = document.querySelector('variant-selects, variant-radios');
    if (variantComponent) {
      variantComponent.addEventListener('change', () => {
        // Small delay to let Dawn update the hidden #id input
        setTimeout(() => {
          const variant = getSelectedVariant();
          console.log('[KAS] variant-selects change, variant:', variant?.title, variant?.price);
          updatePricesFromVariant(widget, variant);
        }, 50);
      });
    }

    // 4. Direct input[name=id] or select[name=id] change
    document.addEventListener('change', (e) => {
      if (e.target.name === 'id' || e.target.dataset.productSelect) {
        setTimeout(() => {
          const variant = getSelectedVariant();
          updatePricesFromVariant(widget, variant);
        }, 50);
      }
    });

    // 5. Dawn section re-render via MutationObserver
    //    When Dawn re-renders the price block, recalculate
    const priceBlock = document.querySelector('.price, .product__price, [data-product-price]');
    if (priceBlock) {
      const observer = new MutationObserver(() => {
        setTimeout(() => {
          const variant = getSelectedVariant();
          if (variant) updatePricesFromVariant(widget, variant);
        }, 100);
      });
      observer.observe(priceBlock, { childList: true, subtree: true, characterData: true });
    }

    // ── Initial price load ─────────────────────────────────────
    setTimeout(() => {
      const variant = getSelectedVariant();
      if (variant) updatePricesFromVariant(widget, variant);
    }, 200);
  }

  // ── Sync selling_plan ─────────────────────────────────────────
  function syncSellingPlan(planId) {
    const form = getProductForm();
    if (!form) { console.warn('[KAS] product form not found'); return; }

    document.querySelectorAll('input[name="selling_plan"]').forEach(el => el.remove());

    if (planId) {
      const hidden = document.createElement('input');
      hidden.type  = 'hidden';
      hidden.name  = 'selling_plan';
      hidden.value = planId;
      hidden.id    = 'kas-selling-plan';
      form.insertBefore(hidden, form.firstChild);
      console.log('[KAS] selling_plan set to:', planId);
    } else {
      console.log('[KAS] selling_plan cleared (one-time)');
    }
  }

  function getProductForm() {
    return document.getElementById('product-form')
        || document.querySelector('form[action*="/cart/add"]')
        || document.querySelector('[data-type="add-to-cart-form"]');
  }

  // ── Intercept fetch (Dawn AJAX) ───────────────────────────────
  const _fetch = window.fetch;
  window.fetch = function(url, options) {
    if (typeof url === 'string' && url.includes('/cart/add')) {
      options = options || {};
      const activeCard  = document.querySelector('.sub-option--active');
      const activeRadio = activeCard?.querySelector('.sub-option__radio');
      const planId      = activeRadio ? activeRadio.value : '';

      if (options.body instanceof FormData) {
        options.body.delete('selling_plan');
        if (planId) {
          options.body.append('selling_plan', planId);
          console.log('[KAS] Injected selling_plan into FormData fetch:', planId);
        }
      } else if (typeof options.body === 'string') {
        const params = new URLSearchParams(options.body);
        params.delete('selling_plan');
        if (planId) {
          params.append('selling_plan', planId);
          console.log('[KAS] Injected selling_plan into string fetch:', planId);
        }
        options.body = params.toString();
      }
    }
    return _fetch.apply(this, [url, options]);
  };

  // ── Intercept XHR ─────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this._kasUrl = url;
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    if (this._kasUrl && this._kasUrl.includes('/cart/add')) {
      const activeCard  = document.querySelector('.sub-option--active');
      const activeRadio = activeCard?.querySelector('.sub-option__radio');
      const planId      = activeRadio ? activeRadio.value : '';

      if (typeof body === 'string' && planId) {
        const params = new URLSearchParams(body);
        params.delete('selling_plan');
        params.append('selling_plan', planId);
        body = params.toString();
        console.log('[KAS] Injected selling_plan into XHR:', planId);
      }
    }
    return _send.call(this, body);
  };

  // ── Set active card ───────────────────────────────────────────
  function setActive(radio, allCards, savingsEl) {
    allCards.forEach((c) => {
      c.classList.remove('sub-option--active');
      c.setAttribute('aria-checked', 'false');
    });
    const activeCard = radio.closest('.sub-option');
    if (activeCard) {
      activeCard.classList.add('sub-option--active');
      activeCard.setAttribute('aria-checked', 'true');
    }
    if (savingsEl) showSavings(savingsEl, radio, activeCard);
  }

  // ── Savings callout ───────────────────────────────────────────
  function showSavings(savingsEl, radio, card) {
    savingsEl.innerHTML = '';
    if (!card || radio.value === '') return;
    const discount = card.dataset.discount;
    if (!discount || parseFloat(discount) <= 0) return;
    const basePrice  = getBasePrice();
    const planPrice  = parseInt(card.dataset.planPrice || '0', 10);
    const savedCents = basePrice - planPrice;
    if (savedCents <= 0) return;
    savingsEl.innerHTML = `
      <div class="sub-widget__savings-inner">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
          <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
          <path d="m9 12 2 2 4-4"/>
        </svg>
        <span class="sub-widget__savings-text">
          You save <strong>${formatMoney(savedCents)}</strong> with this subscription!
        </span>
      </div>
    `;
  }

  // ── Update page price ─────────────────────────────────────────
  function updatePagePrice(radio) {
    const card = radio.closest('.sub-option');
    if (!card) return;
    const priceSelectors = [
      '.price__regular .price-item--regular',
      '.price .price-item--regular',
      '.product__price .price-item',
      '[data-product-price]',
      '.price-item--regular',
    ];
    let priceEl = null;
    for (const sel of priceSelectors) {
      priceEl = document.querySelector(sel);
      if (priceEl) break;
    }
    if (!priceEl) return;
    const planPrice = card.dataset.planPrice;
    priceEl.textContent = (radio.value === '' || !planPrice)
      ? formatMoney(getBasePrice())
      : formatMoney(parseInt(planPrice, 10));
  }

  // ── Update prices from variant ────────────────────────────────
  function updatePricesFromVariant(widget, variant) {
    // Use passed variant price, or look up from selected variant
    let newPrice = null;

    if (variant?.price) {
      newPrice = variant.price;
    } else {
      const selected = getSelectedVariant();
      if (selected?.price) newPrice = selected.price;
    }

    if (!newPrice) {
      console.warn('[KAS] updatePricesFromVariant: no price found');
      return;
    }

    console.log('[KAS] Updating prices for variant price:', newPrice);

    // Update one-time price
    const onetimeCard  = widget.querySelector('.sub-option:first-of-type');
    const onetimePrice = onetimeCard?.querySelector('.sub-option__price');
    if (onetimePrice) {
      onetimePrice.textContent       = formatMoney(newPrice);
      onetimePrice.dataset.basePrice = newPrice;
    }
    // Store base price on widget for getBasePrice() to find
    widget.dataset.basePrice = newPrice;

    // Update each subscription plan price
    widget.querySelectorAll('.sub-option[data-plan-id]').forEach((card) => {
      const discount    = parseFloat(card.dataset.discount || '0');
      const discountAmt = Math.round((newPrice * discount) / 100);
      const subPrice    = newPrice - discountAmt;
      card.dataset.planPrice = subPrice;
      const priceEl = card.querySelector('.sub-option__price');
      if (priceEl) priceEl.textContent = formatMoney(subPrice);
    });

    // Refresh savings callout for currently active card
    const activeCard  = widget.querySelector('.sub-option--active');
    const activeRadio = activeCard?.querySelector('.sub-option__radio');
    const savingsEl   = widget.querySelector('.sub-widget__savings');
    if (activeRadio && savingsEl) showSavings(savingsEl, activeRadio, activeCard);
  }

  // ── Helpers ───────────────────────────────────────────────────
  function getBasePrice() {
    // Check widget data attribute first (set by updatePricesFromVariant)
    const widget = document.querySelector('.sub-widget');
    if (widget?.dataset.basePrice) return parseInt(widget.dataset.basePrice, 10);

    // Check explicit data-base-price element
    const el = document.querySelector('[data-base-price]');
    if (el?.dataset.basePrice) return parseInt(el.dataset.basePrice, 10);

    // Use currently selected variant
    const variant = getSelectedVariant();
    if (variant?.price) return variant.price;

    return window.ShopifyAnalytics?.meta?.product?.variants?.[0]?.price || 0;
  }

  function formatMoney(cents) {
    if (window.Shopify?.formatMoney) return window.Shopify.formatMoney(cents);
    return detectCurrencySymbol() + (cents / 100).toFixed(2);
  }

  function detectCurrencySymbol() {
    const el = document.querySelector('.price-item, [data-product-price], .product__price');
    if (!el) return '$';
    const match = el.textContent.trim().match(/^[^0-9\s]+/);
    return match ? match[0] : '$';
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
