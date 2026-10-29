// Co-op menus: host / join, notices, and the lobby panel shown on the prep screen.
import { audio } from '../core/audio';
import { GuestNet, HostNet } from '../net/rtc';
import { normCode } from '../net/signaling';
import type { GuestSession, HostSession, MpOpts } from '../net/coop';
import { el, type UI } from './ui';

const NAME_KEY = 'sa-mp-name';
const loadName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } };
const saveName = (n: string) => { try { localStorage.setItem(NAME_KEY, n); } catch { /* ignore */ } };
const cleanName = (n: string) => n.replace(/[<>&"'\u0000-\u001f]/g, '').trim().slice(0, 16) || 'Mage';

export function showNotice(ui: UI, title: string, text: string, onClose?: () => void) {
  const m = ui.modal(title, `<p style="line-height:2;font-size:9px">${text}</p><div class="btns row"><button class="big primary" data-a="ok">OK</button></div>`);
  m.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('[data-a=ok]')) { ui.closeModal(m); onClose?.(); } });
  ui.openModal(m, 'notice');
}

/** Join links look like  .../games/spell-architect/?join=ABCDE */
export function joinLink(code: string): string {
  const u = new URL(location.href);
  u.search = ''; u.hash = '';
  u.searchParams.set('join', code);
  return u.toString();
}

export function showMultiplayer(ui: UI, prefillCode = '') {
  const m = ui.modal('Online Co-op', `
    <div class="mpbox">
      <p class="muted">Up to 4 players share one arena and one horde, each with their own spells, shop and relics. One player hosts; everyone else joins with the room code. Connections are peer-to-peer, so the host's computer runs the fight.</p>
      <label class="mpl">Your name<input class="mpin" data-name maxlength="16" value="${loadName().replace(/"/g, '')}" placeholder="Mage"></label>
      <div class="mpsec">
        <button class="big primary" data-a="host">Host a game</button>
      </div>
      <div class="mpsec">
        <label class="mpl">Room code<input class="mpin code" data-code maxlength="5" value="${prefillCode}" placeholder="ABCDE" autocapitalize="characters"></label>
        <button class="big" data-a="join">Join game</button>
      </div>
      <div class="mpstatus" data-status></div>
    </div>`, '');
  const status = m.querySelector('[data-status]') as HTMLElement;
  const nameEl = m.querySelector('[data-name]') as HTMLInputElement;
  const codeEl = m.querySelector('[data-code]') as HTMLInputElement;
  const say = (t: string, bad = false) => { status.textContent = t; status.classList.toggle('bad', bad); };
  let busy = false;
  codeEl.addEventListener('input', () => { codeEl.value = normCode(codeEl.value); });
  m.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest('button[data-a]') as HTMLElement | null;
    if (!b || busy || b.dataset.a === 'close') return;
    const name = cleanName(nameEl.value);
    saveName(name);
    audio.init(); audio.play('ui');
    if (b.dataset.a === 'host') {
      busy = true; say('Creating a room...');
      try {
        const net = new HostNet({ onPeers() {}, onOpen() {}, onClose() {}, onCtl() {}, onSnap() {}, onError() {} });
        const code = await net.start();
        ui.closeModal(m);
        ui.startMp({ role: 'host', name, code, host: net });
      } catch (err) { say((err as Error).message, true); busy = false; }
    } else if (b.dataset.a === 'join') {
      const code = normCode(codeEl.value);
      if (code.length !== 5) { say('Enter the 5-character room code.', true); return; }
      busy = true; say('Connecting... (this can take a few seconds)');
      const early: Record<string, unknown>[] = [];
      let welcomed: ((m: Record<string, unknown>) => void) | null = null;
      const welcome = new Promise<Record<string, unknown>>((res) => { welcomed = res; });
      const net = new GuestNet({
        onCtl: (msg) => { if (msg.t === 'welcome' && welcomed) { welcomed(msg); welcomed = null; } else early.push(msg); },
        onSnap() {},
        onClose: () => { /* handled by the session once the game scene owns the connection */ },
      });
      try {
        await net.connect(code, name);
        const w = await Promise.race([welcome, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('The host did not respond.')), 8000))]);
        ui.closeModal(m);
        const opts: MpOpts = { role: 'guest', name, code, guest: net, welcome: { pid: Number(w.pid), seed: Number(w.seed), round: Number(w.round) }, early };
        ui.startMp(opts);
      } catch (err) { net.close(); say((err as Error).message, true); busy = false; }
    }
  });
  ui.openModal(m, 'mp');
}

/** The co-op block on the prep screen: room code and players, plus the guest's Ready toggle. Returns the element and a refresher. */
export function lobbyPanel(ui: UI, co: HostSession | GuestSession): HTMLElement {
  const n = el('<div class="lobbyp"></div>');
  const render = () => {
    const players = co.role === 'host' ? co.players() : co.lobby;
    const host = co.role === 'host';
    n.innerHTML = `
      <div class="lbh"><b>CO-OP</b> ${host ? `<span class="roomcode" title="Click to copy the join link" data-copy>ROOM ${co.code}</span>` : `<span class="roomcode">ROOM ${co.code}</span>`}</div>
      <div class="lbp">${players.map((p) => `<span class="lbpl ${p.ready ? 'rd' : ''}">${p.host ? '👑 ' : ''}${p.name}${p.host ? '' : p.ready ? ' ✔ ready' : ' ... shopping'}</span>`).join('') || '<span class="muted">Waiting for players...</span>'}</div>
      ${host ? '<p class="muted">Share the room code or click it to copy a join link. Start the round when everyone is ready.</p>' : ''}`;
  };
  const syncReady = () => { const rb = document.querySelector('[data-a=ready]'); if (rb && co.role === 'guest') rb.textContent = co.ready ? 'Ready (click to change your build)' : 'Ready'; };
  render();
  co.onChange = () => { render(); syncReady(); };
  n.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-copy]')) {
      navigator.clipboard?.writeText(joinLink(co.code)).then(() => ui.announce('LINK COPIED', '#9fd8ff', 'Send it to your friends.')).catch(() => ui.announce('ROOM CODE', '#9fd8ff', co.code));
    }
  });
  return n;
}
