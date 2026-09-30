/* ==========================================================================
   What a person sees in the bot, driven end to end against a fake Telegram.

       node scripts/botux.test.mjs

   Asked for as "when I enter the bot everything must be clear — commands
   should appear, and buttons". What is pinned:

     - the bot sets its own command lists, texts, Menu button and admin
       rights, inside Telegram's limits, once per version of them;
     - its profile photo goes up only on a bot that has none;
     - every command the "/" menu offers gets a real answer, not silence;
     - /start carries the mass-DM disclosure and the add-to-group rights;
     - Help edits one message in place instead of filling the chat;
     - anything typed that is not a command or an address gets a pointer
       back to the menu.
   ========================================================================== */

import { BOT_PROFILE, profileHash, ensureProfile, handleUpdate, mainMenu, helpScreen, DISCLOSURE } from '../src/tgbot.mjs';

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const is = (n, got, want) => (got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));

/* ------------------------------------------------------- a fake Telegram */
const calls = [];
let photos = 0;
const real = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.endsWith('/bot-avatar.jpg')) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200 });
  const m = u.match(/api\.telegram\.org\/bot[^/]+\/(\w+)$/);
  if (!m) return new Response('{}', { status: 404 });
  const method = m[1];
  const body = opts.body instanceof FormData ? opts.body : JSON.parse(opts.body || '{}');
  calls.push({ method, body });
  const result = {
    getMe: { id: 42, is_bot: true, username: 'pumpbubblebot' },
    getUserProfilePhotos: { total_count: photos, photos: [] },
    getChatMember: { status: 'administrator' },
    sendMessage: { message_id: calls.length },
    editMessageText: { message_id: 7 },
  }[method] ?? true;
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
};
const mem = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, _m: m }; };
const env = { TG_BOT_TOKEN: '1:TEST', PUBLIC_ORIGIN: 'https://pumpbubble.fun', TG_COMMUNITY: 'https://t.me/pumpbubble' };
const take = () => calls.splice(0, calls.length);

try {
  /* --------------------------------------------------------- the profile */
  console.log('\nthe profile');
  const P = BOT_PROFILE;
  is('the empty-chat text fits Telegram\'s 512', P.description.length <= 512, true);
  is('the profile line fits Telegram\'s 120', P.short.length <= 120, true);
  for (const [scope, list] of Object.entries(P.commands)) {
    const bad = list.filter(c => !/^[a-z0-9_]{1,32}$/.test(c.command) || !c.description || c.description.length > 256);
    is(`${scope}: every command is a legal name with a description`, bad.length, 0);
    is(`${scope}: has /help`, list.some(c => c.command === 'help'), true);
    is(`${scope}: no command listed twice`, new Set(list.map(c => c.command)).size, list.length);
  }
  is('private chats get /start and /stop', ['start', 'stop'].every(c => P.commands.private.some(x => x.command === c)), true);
  is('group admins get /setup and /settings', ['setup', 'settings'].every(c => P.commands.admins.some(x => x.command === c)), true);
  is('every member command is in the admins\' list too (Telegram shows only the most specific)',
    P.commands.group.every(g => P.commands.admins.some(a => a.command === g.command)), true);
  is('the guard\'s rights are asked for', P.groupRights.can_restrict_members && P.groupRights.can_delete_messages, true);
  is('and nothing it does not need', P.groupRights.can_promote_members || P.groupRights.can_change_info, false);
  is('a channel is asked for posting only', P.channelRights.can_post_messages && !P.channelRights.can_delete_messages, true);

  const store = mem();
  photos = 0;
  let r = await ensureProfile(env, store);
  let sent = take();
  const scopes = sent.filter(c => c.method === 'setMyCommands').map(c => c.body.scope.type).sort().join(',');
  is('commands go to all four scopes', scopes, 'all_chat_administrators,all_group_chats,all_private_chats,default');
  is('the empty-chat text is set', sent.some(c => c.method === 'setMyDescription' && c.body.description === P.description), true);
  is('the profile line is set', sent.some(c => c.method === 'setMyShortDescription'), true);
  is('the Menu button lists commands', sent.some(c => c.method === 'setChatMenuButton' && c.body.menu_button.type === 'commands'), true);
  is('group and channel rights are both set', sent.filter(c => c.method === 'setMyDefaultAdministratorRights').length, 2);
  const up = sent.find(c => c.method === 'setMyProfilePhoto');
  is('a bot with no photo gets ours', r.photo, 'ours');
  is('uploaded as a static JPG attachment', up && JSON.parse(up.body.get('photo')).photo, 'attach://avatar');
  is('recorded as applied', r.applied && r.ok, true);

  r = await ensureProfile(env, store);
  is('the same version is not sent again', take().length, 0);
  is('and says so', r.applied, false);

  const store2 = mem();
  photos = 1;
  r = await ensureProfile(env, store2);
  sent = take();
  is('a photo already on the bot is left alone', r.photo, 'theirs');
  is('nothing is uploaded over it', sent.some(c => c.method === 'setMyProfilePhoto'), false);
  is('the version is a stable hash', profileHash(), profileHash());

  /* ------------------------------------------------------ a private chat */
  console.log('\na private chat');
  const pm = (text, id = 1) => ({ update_id: id, message: { message_id: id, text, chat: { id: 555, type: 'private' }, from: { id: 555, first_name: 'Cas' } } });
  const ctx = { env, store: mem() };
  await handleUpdate(ctx, pm('/start'));
  let msg = take().find(c => c.method === 'sendMessage');
  is('/start answers', !!msg, true);
  is('with the disclosure the mass DM depends on', msg && msg.body.text.includes(DISCLOSURE), true);
  const flat = (msg && msg.body.reply_markup.inline_keyboard.flat()) || [];
  const add = flat.find(b => b.url && b.url.includes('startgroup'));
  is('the add-to-group button asks for the guard\'s rights', !!add && /admin=delete_messages\+restrict_members/.test(add.url), true);
  is('an unsubscribe button', flat.some(b => b.callback_data === 'unsub'), true);
  is('a way into help', flat.some(b => b.callback_data === 'help:menu'), true);
  is('every button fits Telegram\'s 64-byte callback limit', flat.every(b => !b.callback_data || new TextEncoder().encode(b.callback_data).length <= 64), true);
  is('no more than two buttons a row', msg.body.reply_markup.inline_keyboard.every(row => row.length <= 2), true);
  is('the first screen is short', msg.body.text.length < 900, true);

  /* every command the "/" menu offers is answered */
  for (const c of BOT_PROFILE.commands.private) {
    if (c.command === 'stop') continue;   // forgets the user; checked below
    await handleUpdate(ctx, pm('/' + c.command));
    const out = take().filter(x => x.method === 'sendMessage');
    const text = out.map(x => x.body.text).join(' ');
    is(`/${c.command} gets a real answer`, out.length > 0 && !/don’t know that command/.test(text), true);
  }
  await handleUpdate(ctx, pm('/stop'));
  is('/stop confirms', take().some(x => x.method === 'sendMessage' && /nothing more from me/.test(x.body.text)), true);

  await handleUpdate(ctx, pm('/frobnicate'));
  msg = take().find(c => c.method === 'sendMessage');
  is('an unknown command points at the menu', msg && msg.body.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'menu'), true);

  await handleUpdate(ctx, pm('hello?'));
  msg = take().find(c => c.method === 'sendMessage');
  is('plain text is answered, not ignored', !!msg && /Paste a token address/.test(msg.body.text), true);
  await handleUpdate(ctx, pm('7V4vYUApSWg1CWBHSxaE'));
  msg = take().find(c => c.method === 'sendMessage');
  is('half an address says so', !!msg && /part of an address/.test(msg.body.text), true);

  /* help edits the message it was opened from */
  await handleUpdate(ctx, { update_id: 90, callback_query: { id: 'q1', data: 'help:group', from: { id: 555 }, message: { message_id: 7, chat: { id: 555, type: 'private' }, text: 'x' } } });
  const ed = take().find(c => c.method === 'editMessageText');
  is('a help topic replaces the menu in place', !!ed && ed.body.message_id === 7, true);
  is('the group guide starts with the add button', ed && ed.body.reply_markup.inline_keyboard[0][0].url.includes('startgroup'), true);
  is('and says where /setup goes', ed && ed.body.text.includes('/setup'), true);
  is('every topic has a way back', ['menu', 'group', 'wallets', 'traders', 'callers', 'promote', 'privacy']
    .every(t => helpScreen(env, { username: 'pumpbubblebot' }, t).keyboard.flat().some(b => b.callback_data === 'menu')), true);
  is('an unknown topic falls back to the topic list', helpScreen(env, null, 'nope').text, helpScreen(env, null, 'menu').text);
  is('the safety topic warns about fake verifications', /never ask for a private key/.test(helpScreen(env, null, 'privacy').text), true);

  /* ------------------------------------------------------------- a group */
  console.log('\na group');
  const gm = (text, id = 200) => ({ update_id: id, message: { message_id: id, text, chat: { id: -100123, type: 'supergroup', title: 'Test' }, from: { id: 777, first_name: 'Admin' } } });
  await handleUpdate(ctx, gm('/help'));
  msg = take().find(c => c.method === 'sendMessage');
  is('/help in a group lists admin and member commands', !!msg && /Admins/.test(msg.body.text) && /Everyone/.test(msg.body.text), true);
  for (const c of BOT_PROFILE.commands.admins) {
    if (c.command === 'setup' || c.command === 'stop') continue;   // setup resolves a token; stop removes the group
    await handleUpdate(ctx, gm('/' + c.command));
    is(`/${c.command} in a group gets an answer`, take().some(x => x.method === 'sendMessage'), true);
  }
  await handleUpdate(ctx, { update_id: 300, my_chat_member: { chat: { id: -100123, type: 'supergroup' }, from: { id: 777 }, date: 1,
    old_chat_member: { status: 'left', user: { id: 42 } }, new_chat_member: { status: 'administrator', user: { id: 42 } } } });
  msg = take().find(c => c.method === 'sendMessage');
  is('being added to a group says what to do next', !!msg && msg.body.text.includes('/setup') && msg.body.text.includes('Type /'), true);

  /* --------------------------------------------------------- the menu text */
  const m = mainMenu(env, { username: 'pumpbubblebot' });
  is('the menu offers the map and the community', m.keyboard.flat().some(b => b.url === 'https://pumpbubble.fun') && m.keyboard.flat().some(b => b.url === 'https://t.me/pumpbubble'), true);
} finally {
  globalThis.fetch = real;
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
