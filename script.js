let player;
let isPlaying = false;
let isLooping = false;
let duration = 0;
let isDragging = false;
let updateInterval;
let pendingPlay = false;
let themePreference = 'auto';
let bufferingRetry;
let awaitingUnmute = false;
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

const allowedOrigin = null;
const themeStorageKey = 'audiotube-theme-preference';

const terminalOrigin = document.getElementById('terminal-origin');
const terminalIframe = document.getElementById('terminal-iframe');
const terminalStatusDot = document.getElementById('terminal-status-dot');
const terminalStatusText = document.getElementById('terminal-status-text');

const terminalStates = {
    idle: { className: 'loading', message: 'Idle • ready for commands' },
    loading: { className: 'loading', message: 'Linking to the audio stream…' },
    playing: { className: 'playing', message: 'Streaming steady • lightweight mode' },
    paused: { className: 'paused', message: 'Paused — press Play to resume' },
    buffering: { className: 'loading', message: 'Buffering… optimizing connection' },
    error: { className: 'error', message: 'Stream connection interrupted' }
};

function updateTerminalInfo() {
    const originToShow = (allowedOrigin && allowedOrigin.length) ? allowedOrigin : window.location.origin;
    terminalOrigin.textContent = originToShow || 'local-preview';

    if (player && player.getIframe) {
        try {
            const iframe = player.getIframe();
            terminalIframe.textContent = iframe ? iframe.src : 'iframe pending';
        } catch (err) {
            terminalIframe.textContent = 'iframe not readable';
        }
    } else {
        terminalIframe.textContent = 'not available yet';
    }
}

function setTerminalState(stateKey, customMessage) {
    const state = terminalStates[stateKey] || terminalStates.idle;
    terminalStatusDot.className = `status-dot ${state.className}`;
    terminalStatusText.textContent = customMessage || state.message;
}

function showLoading(show) {
    const loading = document.getElementById('loading');
    loading.style.display = show ? 'block' : 'none';
    if (show) {
        setTerminalState('loading');
    } else if (!isPlaying) {
        setTerminalState('idle');
    }
}

function showError(message) {
    const errorBox = document.getElementById('error-message');
    errorBox.textContent = message;
    errorBox.style.display = 'block';
    setTerminalState('error', message);
}

function clearError() {
    const errorBox = document.getElementById('error-message');
    errorBox.textContent = '';
    errorBox.style.display = 'none';
}

function formatTime(seconds) {
    seconds = Math.max(seconds, 0);
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function updatePlayPauseButton() {
    const btn = document.getElementById('play-pause-btn');
    btn.classList.toggle('is-playing', isPlaying);
    btn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
}

function renderProgress(percent) {
    const clamped = Math.max(0, Math.min(100, percent));
    document.getElementById('progress-bar').style.width = clamped + '%';
    const thumb = document.getElementById('progress-thumb');
    thumb.style.left = clamped + '%';
    thumb.setAttribute('aria-valuenow', clamped.toFixed(0));
}

function updateProgress() {
    if (!player || !duration || isDragging) return;
    const currentTime = player.getCurrentTime();
    const percent = (currentTime / duration) * 100;
    renderProgress(percent);
    document.getElementById('current-time').textContent = formatTime(currentTime);
}

function extractVideoID(url) {
    if (!url) return null;
    const regex = /(?:youtube\.com\/(?:shorts\/|watch\?v=|embed\/)|youtu\.be\/)([\w-]{11})/;
    const match = url.match(regex);
    if (match && match[1]) {
        return match[1];
    }
    try {
        const parsed = new URL(url);
        if (parsed.hostname.includes('youtube.com')) {
            return parsed.searchParams.get('v');
        }
    } catch (err) {
        return null;
    }
    return null;
}

function ensureIframePermissions() {
    if (!player || !player.getIframe) return;
    try {
        const iframe = player.getIframe();
        if (iframe) {
            iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
            iframe.setAttribute('playsinline', '1');
        }
    } catch (err) {
        console.warn('Unable to configure iframe attributes:', err);
    }
}

function applyMobileOptimizations() {
    if (!player || typeof player.setPlaybackQuality !== 'function') return;
    try {
        player.setPlaybackQuality('small');
        setTimeout(() => {
            if (player && typeof player.setPlaybackQuality === 'function') {
                player.setPlaybackQuality('tiny');
            }
        }, 1200);
    } catch (err) {
        console.warn('Failed to set playback quality:', err);
    }
}

function updateMediaSession(title) {
    if ('mediaSession' in navigator) {
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: title || 'AudioTube Stream',
                artist: 'YouTube Audio',
                album: 'AudioTube',
                artwork: [
                    { src: 'https://www.youtube.com/s/desktop/8e90062a/img/favicon_144.png', sizes: '144x144', type: 'image/png' }
                ]
            });

            navigator.mediaSession.setActionHandler('play', () => {
                if (!isPlaying) {
                    togglePlayPause();
                }
            });
            navigator.mediaSession.setActionHandler('pause', () => {
                if (isPlaying) {
                    togglePlayPause();
                }
            });
            navigator.mediaSession.setActionHandler('seekforward', () => seekForward());
            navigator.mediaSession.setActionHandler('seekbackward', () => seekBackward());
        } catch (err) {
            console.warn('MediaSession API limitation:', err);
        }
    }
}

function updateMediaSessionState() {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }
}

function safePlay(options = {}) {
    if (!player || typeof player.playVideo !== 'function') return;

    const {
        terminalMessage,
        songStatus,
        showBlockNotice = true,
        notifyOnBlock = false
    } = options;

    try {
        const playResult = player.playVideo();
        if (playResult && typeof playResult.then === 'function') {
            playResult.then(() => {
                isPlaying = true;
                pendingPlay = false;
                document.getElementById('song-status').textContent = songStatus || 'Playing…';
                updatePlayPauseButton();
                setTerminalState('playing', terminalMessage || terminalStates.playing.message);
                updateMediaSessionState();
            }).catch(err => {
                console.warn('Playback blocked:', err);
                isPlaying = false;
                pendingPlay = true;
                updatePlayPauseButton();
                if (showBlockNotice) {
                    setTerminalState('paused', 'Tap Play to start audio');
                    document.getElementById('song-status').textContent = 'Tap Play to start audio';
                }
                if (notifyOnBlock) {
                    showError('Autoplay was blocked by the browser. Tap Play to continue.');
                }
                updateMediaSessionState();
            });
        } else {
            isPlaying = true;
            pendingPlay = false;
            document.getElementById('song-status').textContent = songStatus || 'Playing…';
            updatePlayPauseButton();
            setTerminalState('playing', terminalMessage || terminalStates.playing.message);
            updateMediaSessionState();
        }
    } catch (err) {
        console.error('safePlay error:', err);
        isPlaying = false;
        pendingPlay = true;
        updatePlayPauseButton();
        if (showBlockNotice) {
            setTerminalState('error', 'Unable to start playback. Try again.');
        }
        if (notifyOnBlock) {
            showError('Could not start audio playback. Please try again.');
        }
    }
}

function togglePlayPause() {
    if (!player) return;
    clearError();
    if (isPlaying) {
        player.pauseVideo();
        pendingPlay = false;
    } else {
        pendingPlay = true;
        if (awaitingUnmute) {
            try {
                player.unMute();
                awaitingUnmute = false;
            } catch (err) {
                console.warn('Unable to unmute before playing:', err);
            }
        }
        safePlay({ terminalMessage: 'Resuming playback…' });
    }
}

function seekBackward() {
    if (!player) return;
    const newTime = Math.max(0, player.getCurrentTime() - 10);
    player.seekTo(newTime, true);
    document.getElementById('current-time').textContent = formatTime(newTime);
}

function seekForward() {
    if (!player) return;
    const newTime = Math.min(duration || 0, player.getCurrentTime() + 10);
    player.seekTo(newTime, true);
    document.getElementById('current-time').textContent = formatTime(newTime);
}

function setVolume(volume) {
    const vol = Math.max(0, Math.min(100, Number(volume)));
    if (player && typeof player.setVolume === 'function') {
        player.setVolume(vol);
        if (vol > 0) {
            try {
                player.unMute();
                awaitingUnmute = false;
            } catch (err) {
                console.warn('Unable to unmute when setting volume:', err);
            }
        }
    }
}

function toggleLoop() {
    isLooping = !isLooping;
    const btn = document.getElementById('loop-btn');
    const label = btn.querySelector('.label');
    btn.classList.toggle('active', isLooping);
    btn.setAttribute('aria-pressed', isLooping ? 'true' : 'false');
    label.textContent = isLooping ? label.dataset.active : label.dataset.default;
    setTerminalState(isLooping ? 'playing' : (isPlaying ? 'playing' : 'idle'), isLooping ? 'Loop enabled — track will repeat' : undefined);
}

function pasteAndPlay() {
    const input = document.getElementById('yt-url');
    if (!navigator.clipboard || !navigator.clipboard.readText) {
        showError('Clipboard API is not available. Paste manually.');
        input.focus();
        return;
    }
    navigator.clipboard.readText().then(text => {
        if (!text || !text.trim()) {
            showError('Clipboard is empty.');
            input.focus();
            return;
        }
        input.value = text.trim();
        pendingPlay = true;
        loadAudio();
    }).catch(err => {
        console.warn('Clipboard read failed:', err);
        showError('Unable to read from clipboard. Paste manually.');
        input.focus();
    });
}

function clearAll() {
    const input = document.getElementById('yt-url');
    input.value = '';
    input.focus();

    if (player) {
        player.destroy();
        player = null;
    }
    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
    }
    if (bufferingRetry) {
        clearTimeout(bufferingRetry);
        bufferingRetry = null;
    }

    isPlaying = false;
    isLooping = false;
    pendingPlay = false;
    duration = 0;
    awaitingUnmute = false;

    document.getElementById('player-card').style.display = 'none';
    const loopBtn = document.getElementById('loop-btn');
    loopBtn.classList.remove('active');
    loopBtn.setAttribute('aria-pressed', 'false');
    const loopLabel = loopBtn.querySelector('.label');
    loopLabel.textContent = loopLabel.dataset.default;
    document.getElementById('song-status').textContent = 'Ready to play';
    document.getElementById('song-title').textContent = 'AudioTube Player';
    document.getElementById('current-time').textContent = '0:00';
    document.getElementById('total-time').textContent = '0:00';
    renderProgress(0);
    updatePlayPauseButton();
    clearError();
    setTerminalState('idle');
    updateMediaSessionState();
}

function loadAudio() {
    clearError();
    const url = document.getElementById('yt-url').value.trim();

    if (!url) {
        showError('Please provide a YouTube link first.');
        return;
    }

    const videoId = extractVideoID(url);
    if (!videoId) {
        showError('That does not look like a valid YouTube link.');
        return;
    }

    showLoading(true);
    setTerminalState('loading', 'Initializing player…');

    if (player) {
        player.destroy();
        player = null;
        if (updateInterval) {
            clearInterval(updateInterval);
            updateInterval = null;
        }
        if (bufferingRetry) {
            clearTimeout(bufferingRetry);
            bufferingRetry = null;
        }
    }

    pendingPlay = true;
    awaitingUnmute = isMobile;

    player = new YT.Player('youtube-player', {
        height: '1',
        width: '1',
        videoId: videoId,
        playerVars: {
            autoplay: 1,
            playsinline: 1,
            controls: 0,
            disablekb: 1,
            fs: 0,
            rel: 0,
            modestbranding: 1,
            iv_load_policy: 3,
            origin: (allowedOrigin && allowedOrigin.length) ? allowedOrigin : window.location.origin
        },
        events: {
            'onReady': onPlayerReady,
            'onStateChange': onPlayerStateChange,
            'onError': onPlayerError
        }
    });

    setTimeout(ensureIframePermissions, 600);
    updateTerminalInfo();
}

function onPlayerReady() {
    showLoading(false);
    ensureIframePermissions();
    applyMobileOptimizations();

    duration = player.getDuration();
    const title = player.getVideoData().title || 'YouTube Audio';

    document.getElementById('song-title').textContent = title;
    document.getElementById('total-time').textContent = formatTime(duration);
    document.getElementById('song-status').textContent = 'Priming playback…';
    document.getElementById('player-card').style.display = 'block';

    if (isMobile) {
        try {
            player.mute();
        } catch (err) {
            console.warn('Unable to mute on mobile init:', err);
        }
    }

    setVolume(document.getElementById('volume-slider').value);
    updateMediaSession(title);
    updateMediaSessionState();

    if (updateInterval) {
        clearInterval(updateInterval);
    }
    updateInterval = setInterval(updateProgress, 500);

    safePlay({
        terminalMessage: 'Stream initiated • mobile friendly mode',
        songStatus: 'Playing…',
        notifyOnBlock: true
    });
    updateTerminalInfo();
}

function onPlayerStateChange(event) {
    const status = document.getElementById('song-status');

    switch (event.data) {
        case YT.PlayerState.PLAYING:
            status.textContent = 'Playing…';
            isPlaying = true;
            pendingPlay = false;
            awaitingUnmute = false;
            setTerminalState('playing', 'Streaming steady • lightweight mode');
            updateMediaSessionState();
            if (bufferingRetry) {
                clearTimeout(bufferingRetry);
                bufferingRetry = null;
            }
            break;
        case YT.PlayerState.PAUSED:
            status.textContent = 'Paused';
            isPlaying = false;
            pendingPlay = false;
            setTerminalState('paused');
            updateMediaSessionState();
            break;
        case YT.PlayerState.BUFFERING:
            status.textContent = 'Buffering…';
            pendingPlay = true;
            setTerminalState('buffering');
            applyMobileOptimizations();
            if (bufferingRetry) {
                clearTimeout(bufferingRetry);
            }
            if (isMobile) {
                bufferingRetry = setTimeout(() => {
                    if (!player) return;
                    const state = player.getPlayerState();
                    if (state === YT.PlayerState.BUFFERING) {
                        try {
                            player.setPlaybackQuality('tiny');
                        } catch (err) {
                            console.warn('Unable to downgrade quality:', err);
                        }
                        safePlay({ terminalMessage: 'Re-stabilizing mobile stream…', showBlockNotice: false });
                    }
                }, 1800);
            }
            break;
        case YT.PlayerState.ENDED:
            if (isLooping) {
                player.seekTo(0, true);
                pendingPlay = true;
                safePlay({ terminalMessage: 'Loop active', showBlockNotice: false });
                status.textContent = 'Looping…';
            } else {
                status.textContent = 'Playback finished';
                isPlaying = false;
                pendingPlay = false;
                setTerminalState('paused', 'Playback finished');
                updateMediaSessionState();
            }
            break;
        case YT.PlayerState.CUED:
            status.textContent = 'Ready to play';
            isPlaying = false;
            setTerminalState('idle');
            break;
        default:
            break;
    }
    updatePlayPauseButton();
}

function onPlayerError(event) {
    showLoading(false);
    isPlaying = false;
    pendingPlay = false;
    updatePlayPauseButton();
    updateMediaSessionState();

    let errorMessage = 'Something went wrong while loading the audio. ';
    switch (event.data) {
        case 2:
            errorMessage += 'The video ID is invalid.';
            break;
        case 5:
            errorMessage += 'The video cannot play in the HTML5 player.';
            break;
        case 100:
            errorMessage += 'The video was not found or was removed.';
            break;
        case 101:
        case 150:
            errorMessage += 'The video owner restricted playback.';
            break;
        default:
            errorMessage += 'Please try again.';
    }
    showError(errorMessage);
}

function initProgressBar() {
    const container = document.getElementById('progress-container');
    const thumb = document.getElementById('progress-thumb');
    let activePointerId = null;

    function getClientX(event) {
        if (event.touches && event.touches.length) return event.touches[0].clientX;
        if (event.changedTouches && event.changedTouches.length) return event.changedTouches[0].clientX;
        return event.clientX;
    }

    function getPercentFromClientX(clientX) {
        const rect = container.getBoundingClientRect();
        const x = clientX - rect.left;
        return Math.max(0, Math.min(100, (x / rect.width) * 100));
    }

    function updateDuringDrag(percent) {
        renderProgress(percent);
        if (duration) {
            document.getElementById('current-time').textContent = formatTime((percent / 100) * duration);
        }
    }

    function commitSeek(percent) {
        if (player && duration) {
            player.seekTo((percent / 100) * duration, true);
        }
    }

    if (window.PointerEvent) {
        thumb.addEventListener('pointerdown', e => {
            activePointerId = e.pointerId;
            isDragging = true;
            updateDuringDrag(getPercentFromClientX(getClientX(e)));
            e.preventDefault();
        });

        container.addEventListener('pointerdown', e => {
            if (e.target === thumb) return;
            activePointerId = e.pointerId;
            const percent = getPercentFromClientX(getClientX(e));
            updateDuringDrag(percent);
            commitSeek(percent);
            isDragging = true;
            e.preventDefault();
        });

        window.addEventListener('pointermove', e => {
            if (!isDragging || (activePointerId !== null && e.pointerId !== activePointerId)) return;
            updateDuringDrag(getPercentFromClientX(getClientX(e)));
        });

        const finishPointer = e => {
            if (!isDragging || (activePointerId !== null && e.pointerId !== activePointerId)) return;
            const percent = getPercentFromClientX(getClientX(e));
            updateDuringDrag(percent);
            commitSeek(percent);
            isDragging = false;
            activePointerId = null;
        };

        window.addEventListener('pointerup', finishPointer);
        window.addEventListener('pointercancel', finishPointer);
    } else {
        thumb.addEventListener('touchstart', e => {
            isDragging = true;
            updateDuringDrag(getPercentFromClientX(getClientX(e)));
            e.preventDefault();
        }, { passive: false });

        thumb.addEventListener('touchmove', e => {
            if (!isDragging) return;
            updateDuringDrag(getPercentFromClientX(getClientX(e)));
            e.preventDefault();
        }, { passive: false });

        thumb.addEventListener('touchend', e => {
            if (!isDragging) return;
            const percent = getPercentFromClientX(getClientX(e));
            updateDuringDrag(percent);
            commitSeek(percent);
            isDragging = false;
        });

        container.addEventListener('touchstart', e => {
            if (e.target === thumb) return;
            const percent = getPercentFromClientX(getClientX(e));
            updateDuringDrag(percent);
            commitSeek(percent);
        }, { passive: true });

        thumb.addEventListener('mousedown', e => {
            isDragging = true;
            updateDuringDrag(getPercentFromClientX(getClientX(e)));
            e.preventDefault();
        });

        window.addEventListener('mousemove', e => {
            if (!isDragging) return;
            updateDuringDrag(getPercentFromClientX(getClientX(e)));
        });

        window.addEventListener('mouseup', e => {
            if (!isDragging) return;
            const percent = getPercentFromClientX(getClientX(e));
            updateDuringDrag(percent);
            commitSeek(percent);
            isDragging = false;
        });
    }
}

function handleResumeGesture() {
    if (pendingPlay && player && !isPlaying) {
        if (awaitingUnmute) {
            try {
                player.unMute();
            } catch (err) {
                console.warn('Unable to unmute on resume gesture:', err);
            }
            awaitingUnmute = false;
        }
        safePlay({ terminalMessage: 'Resuming after user interaction', showBlockNotice: false });
    }
}

function handleVisibilityChange() {
    if (!player) return;
    if (document.visibilityState === 'visible') {
        if (pendingPlay) {
            safePlay({ terminalMessage: 'Resuming after returning', showBlockNotice: false });
        } else if (isPlaying) {
            safePlay({ terminalMessage: 'Keeping playback alive', showBlockNotice: false });
        }
    } else if (document.visibilityState === 'hidden' && isPlaying) {
        safePlay({ terminalMessage: 'Maintaining background playback', showBlockNotice: false });
    }
}

function applyTheme(preference, { save = true } = {}) {
    themePreference = preference;
    if (save) {
        try {
            localStorage.setItem(themeStorageKey, preference);
        } catch (err) {
            console.warn('Unable to store theme preference:', err);
        }
    }
    const resolved = preference === 'auto' ? (prefersDark.matches ? 'dark' : 'light') : preference;
    document.body.setAttribute('data-theme', resolved);
    document.querySelectorAll('.theme-toggle button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === preference);
    });
}

function initTheme() {
    let stored;
    try {
        stored = localStorage.getItem(themeStorageKey);
    } catch (err) {
        stored = null;
    }
    if (stored && ['light', 'dark', 'auto'].includes(stored)) {
        applyTheme(stored, { save: false });
    } else {
        applyTheme('auto', { save: false });
    }
}

window.onYouTubeIframeAPIReady = function onYouTubeIframeAPIReady() {
    console.log('YouTube API ready');
};

window.addEventListener('load', () => {
    initTheme();
    updateTerminalInfo();
    initProgressBar();
    setTerminalState('idle');

    document.getElementById('yt-url').focus();
    document.getElementById('play-btn').addEventListener('click', loadAudio);
    document.getElementById('paste-play-btn').addEventListener('click', pasteAndPlay);
    document.getElementById('clear-btn').addEventListener('click', clearAll);
    document.getElementById('yt-url').addEventListener('keypress', e => {
        if (e.key === 'Enter') {
            loadAudio();
        }
    });
    document.getElementById('volume-slider').addEventListener('input', e => setVolume(e.target.value));
    document.getElementById('loop-btn').addEventListener('click', toggleLoop);
    document.getElementById('backward-btn').addEventListener('click', seekBackward);
    document.getElementById('forward-btn').addEventListener('click', seekForward);
    document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);
    document.querySelectorAll('.theme-toggle button').forEach(btn => {
        btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
    });
});

setInterval(updateTerminalInfo, 2500);
window.addEventListener('resize', updateTerminalInfo);
prefersDark.addEventListener('change', () => {
    if (themePreference === 'auto') {
        applyTheme('auto', { save: false });
    }
});

document.addEventListener('visibilitychange', handleVisibilityChange);
window.addEventListener('pageshow', event => {
    if (event.persisted && (isPlaying || pendingPlay) && player) {
        safePlay({ terminalMessage: 'Resuming after return', showBlockNotice: false });
    }
});
window.addEventListener('focus', () => {
    if (isPlaying && player) {
        safePlay({ terminalMessage: 'Keeping playback active', showBlockNotice: false });
    }
});
document.addEventListener('click', handleResumeGesture);
document.addEventListener('touchend', handleResumeGesture, { passive: true });
