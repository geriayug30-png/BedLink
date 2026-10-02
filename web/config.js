// Public browser settings only. The publishable/anon key is designed for browser use.
// Never put a Supabase service-role key or database URL/password in this file.
window.BEDLINK_CONFIG = {
  apiBaseUrl: `${location.origin}/api/v1`,
  supabaseUrl: 'http://127.0.0.1:54321',
  supabasePublishableKey: '',
};
