import React from 'react';

export default function SavedAccounts({ accounts, activeAccountId, onConnect, busy, connecting = false }) {
  if (!accounts.length) return null;

  return (
    <section aria-label="Saved ChatGPT accounts" className="space-y-2">
      <h2 className="text-sm font-semibold text-gray-800">Saved accounts</h2>
      <ul className="space-y-2">
        {accounts.map(account => {
          const active = account.id === activeAccountId;
          const label = account.label || account.email || account.name || 'ChatGPT account';
          return (
            <li key={account.id}>
              <button
                type="button"
                onClick={() => onConnect(account.id)}
                disabled={busy || active}
                aria-current={active ? 'true' : undefined}
                aria-label={active ? `${label}, active account` : account.pending ? `Finish signing in to ${label}` : `Continue with ${label}`}
                className={`w-full flex items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm ${active ? 'border-blue-200 bg-blue-50' : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50 disabled:opacity-50'}`}
              >
                <span className="min-w-0 break-words">
                  <span className="block font-medium text-gray-900">{label}</span>
                  {account.email && !label.includes(account.email) && <span className="mt-0.5 block text-xs text-gray-500">{account.email}</span>}
                  {account.pending && <span className="mt-0.5 block text-xs text-gray-500">Sign-in not finished</span>}
                </span>
                <span className={`shrink-0 text-xs ${active ? 'font-medium text-blue-700' : 'text-gray-500'}`}>{active ? 'Active' : account.pending ? 'Finish sign-in' : 'Continue'}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {connecting && <p role="status" className="text-sm text-gray-600">Opening ChatGPT…</p>}
    </section>
  );
}
