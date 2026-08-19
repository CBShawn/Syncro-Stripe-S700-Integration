// content.js
(function () {
  console.log('🚀 [S700 Script Loaded] Current URL:', window.location.href);

  if (window.location.pathname.match(/\/payments\/\d+/)) {
    return;
  }

  // =========================================================================
  // ROUTE: INVOICE PAGE (/invoices/:id)
  // =========================================================================
  const invoiceMatch = window.location.pathname.match(/\/invoices\/(\d+)/);
  if (!invoiceMatch) return;
  const invoiceId = invoiceMatch[1];

  let pollInterval = null;

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  function getLineItems() {
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
          items.push({ description, amount: Math.round(unitPrice * 100), quantity });
        }
      }
    });
    return items;
  }

  function openReceiptWindow(baseUrl) {
    try {
      const receiptUrl = `${baseUrl.replace(/\/+$/, '')}/receipt/${invoiceId}`;
      window.open(
        receiptUrl,
        'SyncroReceiptWindow',
        'width=400,height=650,left=100,top=100,resizable=yes,scrollbars=yes'
      );
    } catch (e) {
      console.warn('⚠️ Receipt popup blocked or failed:', e);
    }
  }

  function pollPaymentStatus(baseUrl, authKey, btn) {
    stopPolling();
    let attempts = 0;

    console.log(`⏱️ Polling started for Invoice #${invoiceId}...`);

    pollInterval = setInterval(async () => {
      attempts++;
      try {
        const cleanBase = baseUrl.replace(/\/+$/, '');
        const res = await fetch(`${cleanBase}/payment-status/${invoiceId}`, {
          headers: {
            'x-extension-key': authKey || ''
          }
        });

        if (!res.ok) return;

        const data = await res.json();
        const status = data.status || data.record?.status;
        const paymentId = data.paymentId || data.record?.paymentId || data.payment_id;

        if (status === 'paid' && paymentId) {
          stopPolling();

          btn.innerText = '✅ Paid in Full!';
          btn.style.backgroundColor = '#2e7d32';
          btn.style.borderColor = '#2e7d32';

          // Prompt user before printing
          const wantsReceipt = confirm('Payment Successful!\n\nWould you like to print the 80mm customer receipt?');

          if (wantsReceipt) {
            openReceiptWindow(cleanBase);
          }

          // Topaz redirect bypassed: reload current invoice to show $0.00 balance
          setTimeout(() => {
            window.location.reload();
          }, 800);

          return;
        }
      } catch (err) {
        console.warn('Polling error:', err);
      }

      if (attempts >= 60) {
        stopPolling();
        btn.innerText = '⚠️ Check Terminal Status';
        btn.disabled = false;
      }
    }, 1500);
  }

  // =========================================================================
  // HANDLER: PAY & SIGN (S700 TERMINAL)
  // =========================================================================
  async function handlePayAndSign(e) {
    e.preventDefault();
    const btn = e.currentTarget;
    btn.innerText = '⌛ Initializing...';
    btn.disabled = true;

    chrome.storage.sync.get(['renderApiUrl', 'extensionAuthKey'], async (data) => {
      const baseUrl = data.renderApiUrl;
      const authKey = data.extensionAuthKey;

      if (!baseUrl) {
        alert('Please configure your Backend URL in Extension Options!');
        btn.innerText = 'Pay & Sign (S700)';
        btn.disabled = false;
        return;
      }

      const lineItems = getLineItems();
      const amountEl = document.querySelector('.invoice-balance, .total-due, .amount-due, [data-balance-due], .balance-due');
      const cleanAmount = parseFloat((amountEl?.innerText || '0').replace(/[^0-9.]/g, '')) || 0;
      const amountCents = cleanAmount > 0 ? Math.round(cleanAmount * 100) : null;

      const customerLink = document.querySelector('a[href*="/customers/"]') || document.querySelector('.customer-card a');
      const customerIdMatch = customerLink ? customerLink.href.match(/\/customers\/(\d+)/) : null;
      const customerId = customerIdMatch ? customerIdMatch[1] : null;

      btn.innerText = '⌛ Displaying on S700...';

      try {
        const payload = { invoiceId, lineItems };
        if (customerId) payload.customerId = customerId;
        if (amountCents) payload.amountCents = amountCents;

        const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/terminal/pay-and-sign`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-extension-key': authKey || ''
          },
          body: JSON.stringify(payload)
        });

        const resData = await response.json();
        if (!response.ok || !resData.success) {
          throw new Error(resData.error || `HTTP ${response.status}`);
        }

        btn.innerText = '📲 Sent! Awaiting Terminal...';
        btn.style.backgroundColor = '#0288d1';
        btn.style.borderColor = '#0288d1';

        pollPaymentStatus(baseUrl, authKey, btn);
      } catch (err) {
        alert('Payment Error: ' + err.message);
        btn.innerText = 'Pay & Sign (S700)';
        btn.style.backgroundColor = '';
        btn.style.borderColor = '';
        btn.disabled = false;
        stopPolling();
      }
    });
  }

  // =========================================================================
  // HANDLER: SEND PAYMENT EMAIL (ACH / CARD)
  // =========================================================================
  async function handleSendPaymentEmail(e) {
    e.preventDefault();
    const btn = e.currentTarget;
    const origText = btn.innerText;

    chrome.storage.sync.get(['renderApiUrl', 'extensionAuthKey'], async (data) => {
      const baseUrl = data.renderApiUrl;
      const authKey = data.extensionAuthKey;

      if (!baseUrl) {
        alert('Please configure your Backend URL in Extension Options!');
        return;
      }

      const amountEl = document.querySelector('.invoice-balance, .total-due, .amount-due, [data-balance-due], .balance-due');
      const cleanAmount = parseFloat((amountEl?.innerText || '0').replace(/[^0-9.]/g, '')) || 0;

      const customerLink = document.querySelector('a[href*="/customers/"]') || document.querySelector('.customer-card a');
      const customerIdMatch = customerLink ? customerLink.href.match(/\/customers\/(\d+)/) : null;
      const customerId = customerIdMatch ? customerIdMatch[1] : null;

      btn.innerText = '⌛ Sending Link...';
      btn.disabled = true;

      try {
        const payload = { invoiceId, amount: cleanAmount };
        if (customerId) payload.customerId = customerId;

        const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/send-payment-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-extension-key': authKey || ''
          },
          body: JSON.stringify(payload)
        });

        const resData = await response.json();
        if (!response.ok || !resData.success) {
          throw new Error(resData.error || `HTTP ${response.status}`);
        }

        btn.innerText = '✅ Email Sent!';
        btn.style.backgroundColor = '#00796b';
        btn.style.borderColor = '#00796b';

        setTimeout(() => {
          btn.innerText = origText;
          btn.style.backgroundColor = '';
          btn.style.borderColor = '';
          btn.disabled = false;
        }, 3500);
      } catch (err) {
        alert('Email Error: ' + err.message);
        btn.innerText = origText;
        btn.disabled = false;
      }
    });
  }

  // =========================================================================
  // HANDLER: MANUAL PRINT 80MM RECEIPT
  // =========================================================================
  function handlePrintReceipt(e) {
    e.preventDefault();
    chrome.storage.sync.get(['renderApiUrl'], (data) => {
      const baseUrl = data.renderApiUrl;
      if (!baseUrl) {
        alert('Please configure your Backend URL in Extension Options!');
        return;
      }
      openReceiptWindow(baseUrl);
    });
  }

  // =========================================================================
  // BUTTON INJECTION
  // =========================================================================
  function injectButtons() {
    let printBtn = document.getElementById('stripe-print-receipt-btn');
    if (!printBtn) {
      const targetArea =
        document.querySelector('.page-actions') ||
        document.querySelector('.header-actions') ||
        document.querySelector('.btn-toolbar') ||
        document.querySelector('a.btn-teal[href*="/payment_form"]')?.parentNode ||
        document.querySelector('a[href*="/print"]')?.parentNode ||
        document.querySelector('a[href*="/pdf"]')?.parentNode ||
        document.querySelector('.page-title-actions') ||
        document.querySelector('h1, h2');

      if (targetArea) {
        printBtn = document.createElement('button');
        printBtn.id = 'stripe-print-receipt-btn';
        printBtn.type = 'button';
        printBtn.innerText = '🖨️ Print 80mm Receipt';
        printBtn.className = 'btn btn-default btn-sm';
        printBtn.style.cssText = 'margin-left: 8px; margin-right: 4px; vertical-align: middle; background-color: #374151; color: #fff; border: 1px solid #374151; font-weight: 600; cursor: pointer; border-radius: 4px; padding: 4px 10px; display: inline-flex; align-items: center;';
        printBtn.addEventListener('click', handlePrintReceipt);

        if (targetArea.tagName === 'H1' || targetArea.tagName === 'H2') {
          targetArea.appendChild(printBtn);
        } else {
          targetArea.insertBefore(printBtn, targetArea.firstChild);
        }
      }
    }

    const takePaymentBtn = document.querySelector('a.btn-teal[href*="/payment_form"]');
    if (takePaymentBtn) {
      let s700Btn = document.getElementById('stripe-s700-pay-btn');
      if (!s700Btn) {
        s700Btn = document.createElement('button');
        s700Btn.id = 'stripe-s700-pay-btn';
        s700Btn.type = 'button';
        s700Btn.innerText = 'Pay & Sign (S700)';
        s700Btn.className = 'btn btn-teal btn-sm';
        s700Btn.style.cssText = 'margin-left: 6px; margin-right: 0; vertical-align: middle;';
        s700Btn.addEventListener('click', handlePayAndSign);
        takePaymentBtn.parentNode.insertBefore(s700Btn, takePaymentBtn.nextSibling);
      }

      let emailBtn = document.getElementById('stripe-email-ach-btn');
      if (!emailBtn) {
        emailBtn = document.createElement('button');
        emailBtn.id = 'stripe-email-ach-btn';
        emailBtn.type = 'button';
        emailBtn.innerText = '✉️ Email Link (ACH/Card)';
        emailBtn.className = 'btn btn-info btn-sm';
        emailBtn.style.cssText = 'margin-left: 6px; margin-right: 0; vertical-align: middle;';
        emailBtn.addEventListener('click', handleSendPaymentEmail);
        (s700Btn || takePaymentBtn).parentNode.insertBefore(emailBtn, (s700Btn || takePaymentBtn).nextSibling);
      }
    }
  }

  injectButtons();

  let obsTimer = null;
  const observer = new MutationObserver(() => {
    if (obsTimer) return;
    obsTimer = setTimeout(() => {
      injectButtons();
      obsTimer = null;
    }, 400);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
