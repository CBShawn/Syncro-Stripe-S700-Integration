(function () {
  console.log('🖊️ [Main World] Payment Auto-Sign active on:', window.location.href);

  function triggerPageSign() {
    const signBtn = document.getElementById('SignBtn') || 
                    document.querySelector('input[value="Start Signing"]');

    if (signBtn) {
      console.log('🖊️ [Main World] Firing native onSign()...');
      
      if (typeof window.onSign === 'function') {
        if (typeof window.jQuery !== 'undefined') {
          window.jQuery('.bhv-showMeOnStart').toggle();
        }
        window.onSign();
        return true;
      } else {
        signBtn.click();
        return true;
      }
    }
    return false;
  }

  if (!triggerPageSign()) {
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      if (triggerPageSign() || attempts >= 25) {
        clearInterval(interval);
      }
    }, 250);
  }
})();
