// @vitest-environment jsdom
import { translator } from '@sds/i18n';
import type { InvitePreviewResponse, StaffRole } from '@sds/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import { takeInviteToken } from '../platform/appLocation.ts';
import { InvitePage } from './InvitePage.tsx';
import { createInviteStore } from './invite-store.ts';

afterEach(cleanup);
const tr = translator('th');

const TOKEN = 'tok_MADEUP_invite_token_0001';
const PASSWORD = 'a long enough made-up password';
const SECRET = 'JBSWY3DPEHPK3PXA';

const previewFor = (role: StaffRole, displayName: string | null = null): InvitePreviewResponse => ({
  email: 'new@example.test',
  role,
  displayName,
  totp: {
    secretBase32: SECRET,
    otpauthUri: `otpauth://totp/Shop:new?secret=${SECRET}&issuer=Shop`,
  },
});

type Calls = Pick<ApiClient['auth'], 'invitePreview' | 'inviteAccept'>;

async function open(over: Partial<Calls> = {}, role: StaffRole = 'cashier') {
  const api = {
    invitePreview: vi.fn(over.invitePreview ?? (async () => previewFor(role))),
    inviteAccept: vi.fn(
      over.inviteAccept ??
        (async () => ({
          recoveryCodes: ['ABCD-EFGH-JKLM-NPQR', 'ABCD-EFGH-JKLM-NPQS'],
        })),
    ),
  };
  const store = createInviteStore({ api });
  const clipboard = { copyText: vi.fn(async (_text: string) => true) };
  store.start(TOKEN);
  render(<InvitePage store={store} clipboard={clipboard} />);
  return { api, store, clipboard };
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) =>
  fireEvent.change(field(label), { target: { value } });

function fillForm(over: { pin?: string; code?: string } = {}) {
  type(tr('invite.name'), 'น้องนก');
  type(tr('invite.password'), PASSWORD);
  type(tr('invite.pin'), over.pin ?? '1234');
  type(tr('invite.pin2'), over.pin ?? '1234');
  type(tr('invite.code'), over.code ?? '123456');
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: tr('invite.submit') }));

describe('the invite page', () => {
  let setItem: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    setItem = vi.spyOn(Storage.prototype, 'setItem');
  });
  afterEach(() => setItem.mockRestore());

  test('shows who the invite is for, the QR and the key as text, and asks for the first code', async () => {
    const { api } = await open(
      { invitePreview: async () => previewFor('manager', 'ผู้จัดการนก') },
      'manager',
    );
    expect(await screen.findByText(tr('invite.youAre', { role: tr('role.manager') }))).toBeTruthy();
    expect(field(tr('invite.email')).value).toBe('new@example.test');
    expect(field(tr('invite.email')).readOnly).toBe(true);
    expect(field(tr('invite.email')).autocomplete).toBe('username');
    expect(field(tr('invite.password')).autocomplete).toBe('new-password');
    expect(field(tr('invite.code')).autocomplete).toBe('one-time-code');
    // The name the owner gave is the starting point.
    expect(field(tr('invite.name')).value).toBe('ผู้จัดการนก');
    expect(
      screen.getByRole('img', { name: tr('invite.totp.qrLabel') }).querySelector('path'),
    ).toBeTruthy();
    expect(screen.getByTestId('totp-secret').textContent).toBe(SECRET);
    // A manager's PIN needs all 6 digits and says so.
    expect(screen.getByText(tr('invite.pinHint.6'))).toBeTruthy();
    expect(api.invitePreview).toHaveBeenCalledTimes(1);
  });

  test('the password shows a strength hint; a short one, a short PIN and a missing code are refused on the screen', async () => {
    const { api } = await open();
    await screen.findByLabelText(tr('invite.password'));
    type(tr('invite.password'), 'short');
    expect(screen.getByText(tr('invite.strength.short'))).toBeTruthy();
    type(tr('invite.password'), 'x'.repeat(12));
    expect(screen.getByText(tr('invite.strength.fair'))).toBeTruthy();
    type(tr('invite.password'), 'x'.repeat(16));
    expect(screen.getByText(tr('invite.strength.strong'))).toBeTruthy();
    type(tr('invite.password'), 'short');
    type(tr('invite.pin'), '12');
    submit();
    expect(screen.getByText(tr('invite.error.displayName'))).toBeTruthy();
    expect(screen.getByText(tr('invite.error.password'))).toBeTruthy();
    expect(screen.getByText(tr('invite.error.pin'))).toBeTruthy();
    expect(screen.getByText(tr('invite.error.code'))).toBeTruthy();
    expect(api.inviteAccept).not.toHaveBeenCalled();
  });

  test('a good form is sent once with the token; the recovery codes are shown once and the way on opens after "I saved them"', async () => {
    const { api, clipboard } = await open();
    await screen.findByLabelText(tr('invite.password'));
    fillForm();
    submit();
    expect(await screen.findByText(tr('invite.done.title'))).toBeTruthy();
    expect(api.inviteAccept).toHaveBeenCalledTimes(1);
    expect(api.inviteAccept).toHaveBeenCalledWith({
      token: TOKEN,
      displayName: 'น้องนก',
      password: PASSWORD,
      pin: '1234',
      totpCode: '123456',
    });
    const codes = within(screen.getByRole('list', { name: tr('invite.done.codesTitle') }));
    expect(codes.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText(tr('invite.done.firstSignIn'))).toBeTruthy();
    // The way on is closed until the person says they saved the codes.
    const closed = screen.getByRole('button', {
      name: tr('invite.done.signIn'),
    }) as HTMLButtonElement;
    expect(closed.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: tr('invite.done.copy') }));
    await waitFor(() =>
      expect(clipboard.copyText).toHaveBeenCalledWith('ABCD-EFGH-JKLM-NPQR\nABCD-EFGH-JKLM-NPQS'),
    );
    expect(await screen.findByText(tr('invite.done.copied'))).toBeTruthy();
    fireEvent.click(screen.getByLabelText(tr('invite.done.saved')));
    const link = screen.getByRole('link', { name: tr('invite.done.signIn') });
    expect(link.getAttribute('href')).toBe('/');
    // The token is in no markup, and nothing was written to storage on the way.
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  test('a wrong authenticator code keeps the form, says so, and clears only the code', async () => {
    const { api } = await open({
      inviteAccept: async () => {
        throw new ApiClientError('INVITE_CODE_INVALID', { status: 422 });
      },
    });
    await screen.findByLabelText(tr('invite.password'));
    fillForm();
    submit();
    expect(await screen.findByText(tr('error.inviteCodeInvalid'))).toBeTruthy();
    expect(field(tr('invite.code')).value).toBe('');
    expect(field(tr('invite.name')).value).toBe('น้องนก');
    expect(field(tr('invite.password')).value).toBe(PASSWORD);
    expect(field(tr('invite.pin')).value).toBe('1234');
    // Still the same form: the QR is still there, and the preview did not run again.
    expect(screen.getByTestId('totp-secret').textContent).toBe(SECRET);
    expect(api.invitePreview).toHaveBeenCalledTimes(1);
    // The next code goes through.
    api.inviteAccept.mockResolvedValueOnce({ recoveryCodes: ['ABCD-EFGH-JKLM-NPQR'] });
    type(tr('invite.code'), '654321');
    submit();
    expect(await screen.findByText(tr('invite.done.title'))).toBeTruthy();
  });

  test.each(['INVITE_INVALID', 'INVITE_ACCEPTED', 'NOT_FOUND'])(
    'an unusable link (%s) shows one generic message and no form',
    async (code) => {
      await open({
        invitePreview: async () => {
          throw new ApiClientError(code, { status: 404 });
        },
      });
      expect(await screen.findByText(tr('error.inviteInvalid'))).toBeTruthy();
      expect(screen.getByText(tr('invite.invalidHelp'))).toBeTruthy();
      expect(screen.queryByLabelText(tr('invite.password'))).toBeNull();
    },
  );

  test('an e-mail that got an account meanwhile or a busy server keeps the form with a message', async () => {
    await open({
      inviteAccept: async () => {
        throw new ApiClientError('EMAIL_TAKEN', { status: 409 });
      },
    });
    await screen.findByLabelText(tr('invite.password'));
    fillForm();
    submit();
    expect(await screen.findByText(tr('error.emailTaken'))).toBeTruthy();
    expect(field(tr('invite.password')).value).toBe(PASSWORD);
  });

  test('offline at the start offers a retry', async () => {
    let fail = true;
    await open({
      invitePreview: async () => {
        if (fail) throw new ApiClientError('NETWORK');
        return previewFor('cashier');
      },
    });
    expect(await screen.findByText(tr('error.network'))).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: tr('common.retry') }));
    expect(await screen.findByLabelText(tr('invite.password'))).toBeTruthy();
  });
});

describe('taking the token out of the address bar', () => {
  test('returns the token, removes the fragment without adding a history entry, and keeps the path', () => {
    window.history.replaceState(null, '', `/invite#${TOKEN}`);
    const length = window.history.length;
    expect(window.location.hash).toBe(`#${TOKEN}`);
    expect(takeInviteToken()).toBe(TOKEN);
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.location.pathname).toBe('/invite');
    expect(window.history.length).toBe(length);
  });

  test('with no fragment there is no token', () => {
    window.history.replaceState(null, '', '/invite');
    expect(takeInviteToken()).toBeNull();
    // A reload after the fragment was removed is the generic state, not an error.
    window.history.replaceState(null, '', '/invite#');
    expect(takeInviteToken()).toBeNull();
  });
});
