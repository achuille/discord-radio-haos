'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  let status = null;
  let online = false;
  let fetching = false;
  let mutating = false;
  let toastTimer;
  let sourceSignature = '';
  let trackSignature = '';
  let pendingRemoval = null;
  const labels = { connected: 'Connecté à Discord', ready: 'Connecté à Discord', connecting: 'Connexion à Discord…', reconnecting: 'Reconnexion à Discord…', disconnected: 'Discord déconnecté', error: 'Connexion en erreur', setup_required: 'Configuration requise', unconfigured: 'Configuration requise', idle: 'En attente' };
  const sourceLabels = { ready: 'Disponible', synced: 'Disponible', syncing: 'Synchronisation…', loading: 'Chargement…', error: 'Erreur', pending: 'En attente', idle: 'En attente', empty: 'Aucun audio trouvé' };
  const playbackLabels = { playing: 'EN LECTURE', paused: 'EN PAUSE', idle: 'EN ATTENTE', stopped: 'À L’ARRÊT', buffering: 'CHARGEMENT', error: 'ERREUR' };
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function notify(message, error = false) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').className = `toast${error ? ' error' : ''}`;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9000 : 4500);
  }
  function time(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value)) || Number(value) < 0) return '—:—';
    const seconds = Math.floor(Number(value));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function controls() {
    const canWrite = online && Boolean(status?.csrfToken) && !mutating;
    const canPlay = canWrite && status?.configured !== false;
    $('toggle').disabled = !canPlay;
    $('skip').disabled = !canPlay || !(status?.tracks?.length);
    $('volume').disabled = !canPlay;
    $('add-source').disabled = !canWrite;
    $('sync-all').disabled = !canWrite || !(status?.sources?.length);
    document.querySelectorAll('.source-actions button').forEach((button) => { button.disabled = !canWrite; });
    $('source-form').setAttribute('aria-busy', String(mutating));
  }
  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`./api/${path}`, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `Le serveur a répondu avec une erreur (${response.status}).`);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Le serveur met trop de temps à répondre. Réessayez.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function renderSources(sources) {
    const signature = JSON.stringify(sources);
    if (signature === sourceSignature) return;
    sourceSignature = signature;
    $('sources-list').replaceChildren();
    $('source-count').textContent = String(sources.length);
    if (!sources.length) {
      $('sources-list').append(el('p', 'empty', 'Votre collection commence ici. Ajoutez une première source pour alimenter la radio.'));
      return;
    }
    for (const source of sources) {
      const row = el('div', 'source-item');
      const drive = source.type === 'drive' || source.type === 'google_drive';
      row.append(el('span', 'source-icon', drive ? '▱' : '♪'));
      const info = el('div', 'source-info');
      let name = source.name || source.title;
      if (!name) {
        try { const url = new URL(source.url); name = drive ? 'Dossier Google Drive' : decodeURIComponent(url.pathname.split('/').pop() || url.hostname); } catch { name = 'Source audio'; }
      }
      const title = el('p', 'source-name', name);
      title.title = source.url || name;
      info.append(title);
      const count = Number.isFinite(Number(source.count)) ? Number(source.count) : 0;
      info.append(el('p', `source-meta${source.error ? ' error' : ''}`, source.error ? String(source.error) : `${sourceLabels[source.state] || source.state || 'En attente'} · ${count} morceau${count === 1 ? '' : 'x'}`));
      row.append(info);
      const actions = el('div', 'source-actions');
      const sync = el('button', 'icon-button', '↻');
      sync.type = 'button'; sync.title = `Actualiser : ${name}`; sync.setAttribute('aria-label', sync.title);
      sync.addEventListener('click', () => mutate('sync', { id: source.id }, 'Synchronisation demandée.'));
      const remove = el('button', 'icon-button', '×');
      remove.type = 'button'; remove.title = `Retirer : ${name}`; remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () => { pendingRemoval = source.id; $('remove-dialog').returnValue = ''; $('remove-dialog').showModal(); });
      actions.append(sync, remove); row.append(actions); $('sources-list').append(row);
    }
  }
  function renderTracks() {
    const tracks = Array.isArray(status?.tracks) ? status.tracks : [];
    const query = $('search').value.trim().toLocaleLowerCase('fr');
    const signature = JSON.stringify([tracks, query]);
    if (signature === trackSignature) return;
    trackSignature = signature;
    $('track-count').textContent = String(tracks.length);
    $('tracks-list').replaceChildren();
    const filtered = tracks.filter((track) => String(track.title || 'Sans titre').toLocaleLowerCase('fr').includes(query));
    if (!filtered.length) {
      $('tracks-list').append(el('p', 'empty', query ? 'Aucun morceau ne correspond à cette recherche.' : 'Pas encore de morceaux. Ils apparaîtront après la synchronisation de vos sources.'));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const [index, track] of filtered.entries()) {
      const row = el('div', 'track-row');
      row.append(el('span', 'track-number', String(index + 1).padStart(2, '0')), el('span', 'track-name', track.title || 'Sans titre'));
      fragment.append(row);
    }
    $('tracks-list').append(fragment);
  }
  function render() {
    const connection = status.connection || {};
    const playback = status.playback || {};
    const connected = ['connected', 'ready'].includes(connection.state);
    $('connection').className = `badge${connected ? ' connected' : connection.state === 'error' ? ' error' : ''}`;
    $('connection').lastElementChild.textContent = labels[connection.state] || 'État de connexion inconnu';
    $('playback-state').textContent = playbackLabels[playback.state] || 'EN ATTENTE';
    document.querySelector('.player').classList.toggle('playing', playback.state === 'playing');
    $('track-title').textContent = playback.title || (playback.state === 'paused' ? 'La radio fait une pause' : 'Prête pour votre musique');
    $('track-kicker').textContent = playback.title ? 'LE MORCEAU DU MOMENT' : 'RADIO DISCORD';
    $('channel').textContent = connection.channel ? `Salon vocal · ${connection.channel}` : 'Aucun salon vocal connecté';
    $('elapsed').textContent = time(playback.elapsed);
    $('duration').textContent = time(playback.duration);
    const progress = Number(playback.duration) > 0 ? Math.max(0, Math.min(100, Number(playback.elapsed || 0) / Number(playback.duration) * 100)) : 0;
    $('progress').style.width = `${progress}%`;
    $('progress').parentElement.setAttribute('aria-valuenow', String(Math.round(progress)));
    $('progress').parentElement.setAttribute('aria-valuetext', playback.duration ? `${time(playback.elapsed)} sur ${time(playback.duration)}` : 'Durée inconnue');
    document.querySelector('.player-foot').textContent = playback.state === 'paused' ? 'La reprise lance le prochain morceau aléatoire, dans Discord.' : 'Le son est diffusé dans Discord, pas dans ce navigateur.';
    $('toggle-icon').textContent = playback.state === 'playing' ? 'Ⅱ' : '▶';
    $('toggle').setAttribute('aria-label', playback.state === 'playing' ? 'Mettre en pause' : 'Démarrer ou reprendre la lecture');
    if (document.activeElement !== $('volume') && Number.isFinite(Number(playback.volume))) {
      $('volume').value = String(Math.min(100, Math.max(0, Number(playback.volume) * 100)));
      $('volume-value').textContent = `${$('volume').value}%`;
    }
    $('notice').hidden = status.configured !== false && !connection.error && !playback.error;
    $('notice').textContent = status.configured === false ? 'Pour démarrer, renseignez le jeton du bot Discord et le salon vocal dans les options du module complémentaire Home Assistant, puis redémarrez-le.' : String(connection.error || playback.error || '');
    renderSources(Array.isArray(status.sources) ? status.sources : []);
    renderTracks(); controls();
  }
  async function refresh() {
    if (fetching) return;
    fetching = true;
    try {
      const next = await request('status');
      if (!next || typeof next !== 'object' || !next.connection || !next.playback) throw new Error('Réponse du serveur invalide.');
      status = next; online = true; render();
    } catch (error) {
      online = false; controls();
      $('connection').className = 'badge error';
      $('connection').lastElementChild.textContent = 'Serveur injoignable';
      document.querySelector('.player').classList.remove('playing');
      $('notice').hidden = false;
      $('notice').textContent = 'Impossible de récupérer l’état de la radio. Vérifiez que le module complémentaire est démarré. Nouvelle tentative automatique.';
      if (status) $('notice').textContent += ' Les informations affichées sont les dernières reçues.';
      else {
        $('playback-state').textContent = 'INDISPONIBLE';
        $('track-title').textContent = 'La radio est indisponible';
        $('channel').textContent = 'En attente du serveur';
        $('sources-list').replaceChildren(el('p', 'empty', 'Sources indisponibles pour le moment.'));
        $('tracks-list').replaceChildren(el('p', 'empty', 'Bibliothèque indisponible pour le moment.'));
      }
    } finally { fetching = false; }
  }
  async function mutate(path, body, message, method = 'POST') {
    if (mutating || !online || !status?.csrfToken) return false;
    mutating = true; controls();
    try {
      await request(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': status.csrfToken }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (message) notify(message);
      await refresh();
      return true;
    } catch (error) { notify(error.message || 'Action impossible. Réessayez.', true); return false; }
    finally { mutating = false; controls(); }
  }
  $('source-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const url = $('source-url').value.trim();
    try { if (new URL(url).protocol !== 'https:') throw new Error(); }
    catch { notify('Utilisez un lien HTTPS valide.', true); return; }
    if (await mutate('sources', { url }, 'Source ajoutée. La synchronisation peut prendre un instant.')) $('source-url').value = '';
  });
  $('toggle').addEventListener('click', () => mutate('control', { action: status?.playback?.state === 'playing' ? 'pause' : 'resume' }));
  $('skip').addEventListener('click', () => mutate('control', { action: 'skip' }));
  $('volume').addEventListener('input', () => { $('volume-value').textContent = `${$('volume').value}%`; });
  $('volume').addEventListener('change', () => mutate('control', { action: 'volume', value: Number($('volume').value) / 100 }));
  $('sync-all').addEventListener('click', () => mutate('sync', {}, 'Synchronisation demandée.'));
  $('search').addEventListener('input', renderTracks);
  $('remove-dialog').addEventListener('close', () => {
    const id = pendingRemoval; pendingRemoval = null;
    if ($('remove-dialog').returnValue === 'confirm' && id !== null) mutate(`sources/${encodeURIComponent(id)}`, {}, 'Source retirée. Les fichiers distants sont conservés.', 'DELETE');
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
})();
