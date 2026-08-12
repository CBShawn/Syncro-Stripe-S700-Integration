(function () {
  const urlMatch = window.location.pathname.match(/\/invoices\/(\d+)/);
  if (!urlMatch) return;
  const invoiceId = urlMatch[1];

  // SINGLETON TRACKER FOR POLLING INTERVAL
  let activePollInterval = null;

  function stopActivePolling() {
    if (activePollInterval) {
      clearInterval(activePollInterval);
      activePollInterval = null;
      console.log('🛑 Existing polling interval cleared.');
    }
  }

  // Helper to maintain a set of locally marked paid invoices across DOM updates
  function getPaidInvoices() {
    try {
      return new Set(JSON.parse(sessionStorage.getItem('stripe_s700_paid_invoices') || '[]'));
    } catch (_) {
      return new Set();
    }
  }

  function setInvoicePaid(id) {
    const paidSet = getPaidInvoices();
    paidSet.add(String(id));
    sessionStorage.setItem('stripe_s700_paid_invoices', JSON.stringify(Array.from(paidSet)));
  }

  function isInvoicePaidLocally(id) {
    return getPaidInvoices().has(String(id));
  }

  function applyPaidStateToButton(btn) {
    if (!btn) return;
    btn.innerText = '✅ Paid!';
    btn.style.backgroundColor = '#2e7d32';
    btn.style.borderColor = '#2e7d32';
    btn.style.color = '#ffffff';
    btn.disabled = true;
    btn.setAttribute('data-paid-locked', 'true');
  }

  function applyAwaitingSignatureStateToButton(btn) {
    if (!btn) return;
    btn.innerText = '✍️ Awaiting Signature on S700...';
    btn.style.backgroundColor = '#f57c00';
    btn.style.borderColor = '#f57c00';
    btn.style.color = '#ffffff';
    btn.disabled = true;
  }

  function getSyncroLineItems() {
    const items = [];
    const rows = document.querySelectorAll('table.invoice-line-items tr, table.table-striped tr');

    rows.forEach(row => {
      const nameEl = row.querySelector('.line-item-name, .description, td:first-child');
      const priceEl = row.querySelector('.unit-price, td:nth-child(3)');
      const qtyEl = row.querySelector('.quantity, td:nth-child(2)');

      if (nameEl && priceEl) {
        const description = nameEl.innerText.trim();
        const unitPrice = parseFloat(priceEl.innerText.replace(/[^0-9.]/g, '')) || 0;
        const quantity = parseInt(qtyEl?.innerText.replace(/[^0-9]/g, '') || '1', 10);

        if (description && unitPrice > 0) {
          items.push({
            description: description,
            amount: Math.round(unitPrice * 100),
            quantity: quantity
          });
        }
      }
    });
    return items;
  }

  /**
   * Polls the middleware status endpoint until payment confirms
   */
  function pollForPaymentStatus(baseUrl, btn) {
    stopActivePolling();

    const maxRetries = 60; // 60 attempts * 2s = 2 minutes timeout
    let attempts = 0;

    activePollInterval = setInterval(async () => {
      attempts++;

      if (btn.getAttribute('data-paid-locked') === 'true' || isInvoicePaidLocally(invoiceId)) {
        stopActivePolling();
        applyPaidStateToButton(btn);
        return;
      }

      try {
        const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
        const response = await fetch(`${cleanBaseUrl}/payment-status/${invoiceId}`);
        if (!response.ok) return;

        const data = await response.json();
        console.log('🔄 Polling Status Response:', data);

        if (data.status === 'paid' && data.stage !== 'awaiting_signature') {
          console.log('✅ Payment fully finalized! Clearing poll interval and marking paid.');
          stopActivePolling();
          setInvoicePaid(invoiceId);
          applyPaidStateToButton(btn);

          setTimeout(() => {
            window.location.reload();
          }, 2500);
          return;
        }

        if (data.stage === 'awaiting_signature') {
          applyAwaitingSignatureStateToButton(btn);
        }

      } catch (err) {
        console.warn('⚠️ Polling error:', err);
      }

      if (attempts >= maxRetries) {
        stopActivePolling();
        if (!isInvoicePaidLocally(invoiceId)) {
          btn.innerText = '⚠️ Check Terminal Status';
          btn.disabled = false;
        }
      }
    }, 2000);
  }

  /**
   * Handles S700 Terminal Pay & Sign
   */
  async function handlePayAndSign(e) {
    e.preventDefault();
    const btn = e.currentTarget;

    if (isInvoicePaidLocally(invoiceId)) {
      applyPaidStateToButton(btn);
      return;
    }

    chrome.storage.sync.get(['renderApiUrl', 'extensionAuthKey'], async (data) => {
      const rawBaseUrl = data.renderApiUrl;
      const authKey = data.extensionAuthKey;

      if (!rawBaseUrl) {
        alert('Please configure your Backend URL in Extension Options first!');
        return;
      }

      const baseUrl = rawBaseUrl.replace(/\/+$/, '');
      const lineItems = getSyncroLineItems();
      
      const amountEl = document.querySelector('.invoice-balance, .total-due, .amount-due, [data-balance-due], .balance-due');
      const amountText = amountEl?.innerText || '0';
      const cleanAmount = parseFloat(amountText.replace(/[^0-9.]/g, '')) || 0;
      const amountCents = cleanAmount > 0 ? Math.round(cleanAmount * 100) : null;

      const customerLink = document.querySelector('a[href*="/customers/"]') || document.querySelector('.customer-card a');
      const customerIdMatch = customerLink ? customerLink.href.match(/\/customers\/(\d+)/) : null;
      const customerId = customerIdMatch ? customerIdMatch[1] : null;

      btn.innerText = '⌛ Displaying on S700...';
      btn.disabled = true;

      try {
        const payload = { invoiceId, lineItems };
        if (customerId) payload.customerId = customerId;
        if (amountCents) payload.amountCents = amountCents;

        const targetUrl = `${baseUrl}/api/terminal/pay-and-sign`;
        console.log('📡 Request sent to:', targetUrl, payload);

        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-extension-key': authKey || ''
          },
          body: JSON.stringify(payload)
        });

        const rawText = await response.text();
        let result = {};
        try {
          result = JSON.parse(rawText);
        } catch (_) {
          result = { error: rawText || `HTTP Error ${response.status}` };
        }

        if (!response.ok || !result.success) {
          throw new Error(result.error || `Server returned status ${response.status}`);
        }

        btn.innerText = '📲 Sent! Awaiting Terminal...';
        btn.style.backgroundColor = '#0288d1';

        pollForPaymentStatus(baseUrl, btn);

      } catch (err) {
        console.error('❌ Terminal Payment Error:', err);
        alert('Payment Error: ' + err.message);
        btn.innerText = 'Pay & Sign (S700)';
        btn.disabled = false;
        stopActivePolling();
      }
    });
  }

  /**
   * Handles sending ACH + Credit Card payment link via email
   */
  async function handleSendPaymentEmail(e) {
    e.preventDefault();
    const btn = e.currentTarget;

    if (isInvoicePaidLocally(invoiceId)) {
      alert('This invoice is already paid!');
      return;
    }

    chrome.storage.sync.get(['renderApiUrl', 'extensionAuthKey'], async (data) => {
      const rawBaseUrl = data.renderApiUrl;
      const authKey = data.extensionAuthKey;

      if (!rawBaseUrl) {
        alert('Please configure your Backend URL in Extension Options first!');
        return;
      }

      const baseUrl = rawBaseUrl.replace(/\/+$/, '');
      
      const amountEl = document.querySelector('.invoice-balance, .total-due, .amount-due, [data-balance-due], .balance-due');
      const amountText = amountEl?.innerText || '0';
      const cleanAmount = parseFloat(amountText.replace(/[^0-9.]/g, '')) || 0;

      const customerLink = document.querySelector('a[href*="/customers/"]') || document.querySelector('.customer-card a');
      const customerIdMatch = customerLink ? customerLink.href.match(/\/customers\/(\d+)/) : null;
      const customerId = customerIdMatch ? customerIdMatch[1] : null;

      const originalText = btn.innerText;
      btn.innerText = '⌛ Generating Link...';
      btn.disabled = true;

      try {
        const payload = { 
          invoiceId, 
          amount: cleanAmount 
        };
        if (customerId) payload.customerId = customerId;

        const targetUrl = `${baseUrl}/api/send-payment-email`;
        console.log('📡 Requesting Payment Email from:', targetUrl, payload);

        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-extension-key': authKey || ''
          },
          body: JSON.stringify(payload)
        });

        const rawText = await response.text();
        let result = {};
        try {
          result = JSON.parse(rawText);
        } catch (_) {
          result = { error: rawText || `HTTP Error ${response.status}` };
        }

        if (!response.ok || !result.success) {
          throw new Error(result.error || `Server returned status ${response.status}`);
        }

        btn.innerText = '✅ Email Sent!';
        btn.style.backgroundColor = '#00796b';
        btn.style.borderColor = '#00796b';

        setTimeout(() => {
          btn.innerText = originalText;
          btn.style.backgroundColor = '';
          btn.style.borderColor = '';
          btn.disabled = false;
        }, 4000);

      } catch (err) {
        console.error('❌ Send Payment Email Error:', err);
        alert('Email Error: ' + err.message);
        btn.innerText = originalText;
        btn.disabled = false;
      }
    });
  }

  function injectCustomButtons() {
    const takePaymentBtn = document.querySelector('a.btn-teal[href*="/payment_form"]');
    if (!takePaymentBtn) return;

    // 1. Inject S700 Button
    let s700Btn = document.getElementById('stripe-s700-pay-btn');
    if (!s700Btn) {
      s700Btn = document.createElement('button');
      s700Btn.id = 'stripe-s700-pay-btn';
      s700Btn.type = 'button';
      s700Btn.innerText = 'Pay & Sign (S700)';
      s700Btn.className = 'btn btn-teal btn-sm';
      s700Btn.style.cssText = `
        margin-left: 6px;
        margin-right: 0;
        vertical-align: middle;
      `;

      s700Btn.addEventListener('click', handlePayAndSign);
      takePaymentBtn.parentNode.insertBefore(s700Btn, takePaymentBtn.nextSibling);

      if (isInvoicePaidLocally(invoiceId)) {
        applyPaidStateToButton(s700Btn);
      }
    } else if (isInvoicePaidLocally(invoiceId)) {
      applyPaidStateToButton(s700Btn);
    }

    // 2. Inject ACH/Card Email Button
    let emailBtn = document.getElementById('stripe-email-ach-btn');
    if (!emailBtn) {
      emailBtn = document.createElement('button');
      emailBtn.id = 'stripe-email-ach-btn';
      emailBtn.type = 'button';
      emailBtn.innerText = '✉️ Email Link (ACH/Card)';
      emailBtn.className = 'btn btn-info btn-sm';
      emailBtn.style.cssText = `
        margin-left: 6px;
        margin-right: 0;
        vertical-align: middle;
      `;

      emailBtn.addEventListener('click', handleSendPaymentEmail);

      const targetAnchor = s700Btn || takePaymentBtn;
      targetAnchor.parentNode.insertBefore(emailBtn, targetAnchor.nextSibling);
    }
  }

  // Initial Injection
  injectCustomButtons();

  // Watch for dynamic DOM re-renders (debounced)
  let observerTimeout = null;
  const observer = new MutationObserver(() => {
    if (observerTimeout) return;
    observerTimeout = setTimeout(() => {
      injectCustomButtons();
      observerTimeout = null;
    }, 500);
  });

  observer.observe(document.body, { childList: true, subtree: true });
})();
