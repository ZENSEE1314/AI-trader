// Temporary fix for cash wallet - override the loadCashWallet function
(function() {
  'use strict';
  
  // Wait for the main app to load
  setTimeout(() => {
    // Override the loadCashWallet function
    if (window.loadCashWallet) {
      const originalLoadCashWallet = window.loadCashWallet;
      
      window.loadCashWallet = async function() {
        try {
          // Use new dashboard endpoint for cash wallet
          const walletData = await api('GET', '/api/dashboard/cash-wallet');
          
          // Update UI with new data
          $('#cw-cash').textContent = `$${walletData.balance.toFixed(2)}`;
          $('#cw-commission').textContent = `$${walletData.total_commission.toFixed(2)}`;
          $('#cw-total').textContent = `$${walletData.total_balance.toFixed(2)}`;
          $('#cw-weekly-fee').textContent = '$0.00';
          $('#cw-weekly-fee-label').textContent = 'No Subscription Fee';
          
          // Update fee status
          const feeCard = $('#cw-fee-status-card');
          $('#cw-fee-status').textContent = '✅ Commission System';
          $('#cw-fee-status').style.color = 'var(--color-success)';
          feeCard.style.borderLeft = '3px solid var(--color-success)';
          $('#cw-fee-warning').classList.add('hidden');
          
          // Update fee details
          $('#cw-fee-details').innerHTML = `
            <div style="margin-bottom: 8px;">
              <strong>Referral Tier:</strong> ${walletData.referral_tier}
            </div>
            <div>
              <strong>Commission Rate:</strong> 10% from downline profits
            </div>
            <div>
              <strong>Total Commission Earned:</strong> $${walletData.total_commission.toFixed(2)}
            </div>
          `;
          
          // Update referral info
          const appUrl = window.location.origin;
          $('#referral-link').value = `${appUrl}/?ref=${walletData.referral_code}`;
          $('#cw-ref-count').textContent = walletData.referral_count;
          
          // USDT address
          $('#cw-usdt-addr').value = walletData.usdt_address || '';
          $('#cw-usdt-net').value = walletData.usdt_network || 'ERC20';
          if (walletData.usdt_address) {
            $('#cw-wd-address-display').textContent = `Sending to: ${walletData.usdt_address.slice(0, 10)}...${walletData.usdt_address.slice(-6)} (${walletData.usdt_network})`;
          } else {
            $('#cw-wd-address-display').textContent = 'Set withdrawal address below';
          }
          
          // Transaction history - show message
          const tbody = $('#cw-txns-tbody');
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--color-text-muted);">Transaction history coming soon</td></tr>';
          
        } catch (err) {
          console.error('Cash wallet load error:', err);
          showToast('Failed to load cash wallet data', 'error');
        }
      };
      
      console.log('Cash wallet fix applied');
    }
  }, 1000);
  
  // Helper function to show toast (if not available)
  function showToast(message, type) {
    if (window.showToast) {
      window.showToast(message, type);
    } else {
      alert(`${type.toUpperCase()}: ${message}`);
    }
  }
  
  // Helper function for API calls (if not available)
  async function api(method, path, body) {
    if (window.api) {
      return window.api(method, path, body);
    }
    
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
})();