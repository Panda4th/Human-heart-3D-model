// The heart-sound controls: the button, the volume and the booking of the sounds from the beat clock (heartsound.mjs has the sounds
// and the clock). Moved out of main.js (Issue #50 E4).

// isFailed: the 3D view has stopped (no sound may start then). limit: the beat time after which no sound is booked.
export function createSoundControl({ $, sound, scheduler, playback, isFailed, limit }) {
  let on = false, pump = 0, watching = false;
  // Heart sounds. The sounds are booked a short time ahead from the playback clock; whenever the clock changes (play, stop,
  // speed, hidden page, sound on or off) the booked sounds are cancelled and booked again from the current position, so a
  // sound is never played twice or after a stop, and past sounds are never played back.
  // No sound is booked after limit() (with reduced motion, the end of the beat being played; see main.js).
  function book() {
    if (on && playback.running && !isFailed()) sound.schedule(scheduler.take(playback, sound.now(), { latency: sound.latency(), limit: limit() }));
  }
  function resync() {
    sound.cancel();
    clearInterval(pump);
    pump = 0;
    if (!on || !playback.running) { scheduler.stop(); return; }
    scheduler.start(playback, sound.now(), sound.latency());
    book();
    // A timer keeps the booking going while frames are late; the audio context plays what is booked on its own clock.
    pump = setInterval(book, 50);
  }
  function setButton() {
    $('heart-sound').setAttribute('aria-pressed', String(on));
  }
  function say(text) {
    $('sound-status').hidden = !text;
    $('sound-status').textContent = text;
  }
  // Sound off: the beat goes on from the same position on the page's own clock.
  // After an interruption the audio clock has stopped, so the position is where it stopped; the page's clock takes over from there.
  function off(message = '') {
    const at = playback.position();
    on = false;
    playback.useSource(() => performance.now() / 1000, at);
    resync();
    setButton();
    say(message);
  }
  $('heart-sound').onclick = async () => {
    if (on) { off(); return; }
    say('');
    // Sound can start only from a tap: the context is created and resumed here, before anything is awaited.
    try { await sound.open(); } catch { /* handled by the state check below */ }
    // The 3D view may have stopped (context lost) while the audio context was starting: the controls are disabled then, and
    // the sound must stay off.
    if (isFailed()) { sound.suspend(); return; }
    if (sound.state !== 'running') { say('音声を開始できませんでした。もう一度押してください。端末が消音になっていないかも確認してください。'); return; }
    if (!on) {
      if (!watching) {
        watching = true;
        sound.onStateChange(() => { if (on && sound.state !== 'running') off('音声が中断されたため、心音を切りました。もう一度押すと再開します。'); });
      }
      // The audio clock takes over at the current position, so the beat does not jump when the sound is turned on.
      playback.useSource(() => sound.now());
      on = true;
      resync();
      setButton();
    }
  };
  $('heart-volume').oninput = () => sound.setVolume(Number($('heart-volume').value));
  if (!sound.supported) {
    $('heart-sound').hidden = true;
    $('heart-volume-label').hidden = true;
    $('sound-note').textContent = 'このブラウザーは音声の再生（Web Audio API）に対応していないため、心音のボタンを表示していません。拍動の表示はそのまま使えます。';
  }
  return {
    resync,
    off,
    get on() { return on; },
  };
}
