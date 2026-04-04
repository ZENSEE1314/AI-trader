// Debug script for login issues
console.log('=== LOGIN DEBUG SCRIPT LOADED ===');

// Override the login form submission to add debugging
document.addEventListener('DOMContentLoaded', function() {
  const loginForm = document.getElementById('form-login');
  if (loginForm) {
    // Store original submit handler
    const originalSubmit = loginForm.onsubmit;
    
    // Add debug version
    loginForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      console.log('=== LOGIN DEBUG START ===');
      
      const email = document.getElementById('login-email')?.value.trim();
      const password = document.getElementById('login-password')?.value;
      const remember = document.getElementById('login-remember')?.checked ?? true;
      
      console.log('Login attempt:', { email, passwordLength: password?.length, remember });
      
      try {
        // Test 1: Check if API endpoint exists
        console.log('Test 1: Checking /api/auth/login endpoint...');
        const testResponse = await fetch('/api/auth/login', {
          method: 'OPTIONS',
          headers: { 'Content-Type': 'application/json' }
        });
        console.log('OPTIONS response:', testResponse.status, testResponse.statusText);
        
        // Test 2: Try actual login
        console.log('Test 2: Attempting login...');
        const startTime = Date.now();
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, password, remember })
        });
        const endTime = Date.now();
        
        console.log('Login response:', {
          status: response.status,
          statusText: response.statusText,
          time: endTime - startTime + 'ms',
          headers: Object.fromEntries(response.headers.entries())
        });
        
        const responseText = await response.text();
        console.log('Response body:', responseText);
        
        if (!response.ok) {
          console.error('Login failed:', response.status, responseText);
          // Show error to user
          const errorEl = document.getElementById('login-error');
          if (errorEl) {
            errorEl.textContent = `Login failed (${response.status}): ${responseText}`;
            errorEl.classList.add('visible');
          }
          return;
        }
        
        console.log('Login successful!');
        
        // Test 3: Check session
        console.log('Test 3: Checking session...');
        const sessionResponse = await fetch('/api/auth/me', {
          credentials: 'include'
        });
        console.log('Session check:', sessionResponse.status, sessionResponse.statusText);
        
        if (sessionResponse.ok) {
          console.log('Session valid, redirecting to dashboard...');
          // Force reload to show dashboard
          window.location.reload();
        } else {
          console.error('Session check failed');
        }
        
      } catch (error) {
        console.error('Login debug error:', error);
        console.error('Error details:', {
          name: error.name,
          message: error.message,
          stack: error.stack
        });
        
        // Show error to user
        const errorEl = document.getElementById('login-error');
        if (errorEl) {
          errorEl.textContent = `Network error: ${error.message}`;
          errorEl.classList.add('visible');
        }
      }
      
      console.log('=== LOGIN DEBUG END ===');
    }, { once: true });
    
    console.log('Login debug handler installed');
  }
  
  // Also add a test button for manual testing
  const debugButton = document.createElement('button');
  debugButton.textContent = 'Debug Login API';
  debugButton.style.position = 'fixed';
  debugButton.style.bottom = '10px';
  debugButton.style.right = '10px';
  debugButton.style.zIndex = '9999';
  debugButton.style.padding = '5px 10px';
  debugButton.style.background = '#f0a030';
  debugButton.style.color = 'white';
  debugButton.style.border = 'none';
  debugButton.style.borderRadius = '3px';
  debugButton.style.cursor = 'pointer';
  
  debugButton.onclick = async function() {
    console.log('=== MANUAL API DEBUG ===');
    
    // Test server status
    try {
      const status = await fetch('/status');
      console.log('Server status:', await status.json());
    } catch (e) {
      console.error('Cannot reach /status:', e.message);
    }
    
    // Test health
    try {
      const health = await fetch('/health');
      console.log('Server health:', await health.json());
    } catch (e) {
      console.error('Cannot reach /health:', e.message);
    }
    
    // Test auth endpoint
    try {
      const authTest = await fetch('/api/auth/login', { method: 'OPTIONS' });
      console.log('Auth endpoint:', authTest.status, authTest.statusText);
    } catch (e) {
      console.error('Cannot reach /api/auth/login:', e.message);
    }
  };
  
  document.body.appendChild(debugButton);
  console.log('Debug button added to page');
});