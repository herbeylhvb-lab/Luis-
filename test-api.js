// Diagnostic: find the actual messages in RumbleUp project 1
const db = require('./db');
const provider = require('./providers/rumbleup');

async function test() {
  // Get contacts from action 1 (the real project)
  console.log('--- Contacts from Action 1 ---');
  try {
    const contacts = await provider.getContacts({ action: '1', _count: 20 });
    console.log('Count:', contacts.count);
    const list = contacts.data || [];
    for (const c of list.slice(0, 10)) {
      console.log('  Phone:', c.phone, '| Name:', c.first_name, c.last_name, '| Flags:', c.flags);
    }

    // Now try message log for first few contacts
    if (list.length > 0) {
      for (const c of list.slice(0, 3)) {
        const ph = c.phone;
        console.log('\n--- Message log for', ph, '---');
        try {
          const log = await provider.getMessageLog({ phone: ph });
          console.log('Count:', log.count, '| Data:', (log.data || []).length);
          if (log.data && log.data.length > 0) {
            for (const m of log.data.slice(0, 3)) {
              console.log('  MSG:', JSON.stringify(m));
            }
          }
        } catch(err) {
          console.log('  ERROR:', err.message);
        }
      }
    }
  } catch(err) {
    console.log('ERROR:', err.message);
  }

  // Also try getMessageLog without a phone — maybe it returns all?
  console.log('\n--- Message log with no phone (just action) ---');
  try {
    const log = await provider.getMessageLog({ action: '1' });
    console.log('Count:', log.count, '| Data:', (log.data || []).length);
    if (log.data && log.data.length > 0) {
      for (const m of log.data.slice(0, 5)) {
        console.log('  MSG:', JSON.stringify(m));
      }
    }
  } catch(err) {
    console.log('ERROR:', err.message);
  }

  // Try with proxy number
  console.log('\n--- Message log for proxy 19565562262 ---');
  try {
    const log = await provider.getMessageLog({ phone: '19565562262' });
    console.log('Count:', log.count, '| Data:', (log.data || []).length);
    if (log.data && log.data.length > 0) {
      for (const m of log.data.slice(0, 3)) {
        console.log('  MSG:', JSON.stringify(m));
      }
    }
  } catch(err) {
    console.log('ERROR:', err.message);
  }

  console.log('\n--- Message log for proxy 19565530255 ---');
  try {
    const log = await provider.getMessageLog({ proxy: '19565530255' });
    console.log('Count:', log.count, '| Data:', (log.data || []).length);
    if (log.data && log.data.length > 0) {
      for (const m of log.data.slice(0, 3)) {
        console.log('  MSG:', JSON.stringify(m));
      }
    }
  } catch(err) {
    console.log('ERROR:', err.message);
  }
}

test().catch(err => console.error('Fatal:', err));
