document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.sync.get(['renderApiUrl', 'extensionAuthKey'], (data) => {
    if (data.renderApiUrl) document.getElementById('apiUrl').value = data.renderApiUrl;
    if (data.extensionAuthKey) document.getElementById('authKey').value = data.extensionAuthKey;
  });

  document.getElementById('saveBtn').addEventListener('click', () => {
    const url = document.getElementById('apiUrl').value.trim().replace(/\/$/, '');
    const key = document.getElementById('authKey').value.trim();

    chrome.storage.sync.set({ renderApiUrl: url, extensionAuthKey: key }, () => {
      const status = document.getElementById('status');
      status.innerText = 'Settings saved successfully!';
      setTimeout(() => { status.innerText = ''; }, 2000);
    });
  });
});
