window.addEventListener('load', () => {

  let manifest = chrome.runtime.getManifest();
  document.title = `${manifest.name} ${manifest.version}`;

  function localBool(item) { 
    return localStorage[item] === 'true';
  }

  // Progress Bars
  // =============

  const circleBar = ProgressBar.Circle;
  let barSettings = {
    color: '#fff',
    strokeWidth: 20,
    trailWidth: 1,
    text: {
      autoStyleContainer: false
    },
    from: { color: '#fff', width: 20 },
    to: { color: '#fff', width: 20 },
    step (state, circle) {
      circle.path.setAttribute('stroke', state.color);
      circle.path.setAttribute('stroke-width', state.width);
      let value = Math.round(circle.value() * 100);
      circle.setText(value === 0 ? '' : `${value}%`);
    }
  };

  let downloadBar = new circleBar($('#download-progress-bar')[0], barSettings);
  let renderBar = new circleBar($('#render-progress-bar')[0], barSettings);

  // DOM Cache
  // =========

  let dom = {
    canvas: {
      display: $('#canvas-display').get(0),
      render: $('#canvas-render').get(0),
    },
    errorMessage: $('#error-message'),
    explodedFrames: $('#exploded-frames'),
    filler: $('#scrubber-bar-filler'),
    pausePlayIcon: $('#play-pause-icon'),
    speedList: $('#speed-list'),
    speeds: $('#speed-list td'),
    bar: $('#scrubber-bar'),
    line: $('#scrubber-bar-line'),
    spacer: $('#bubble-spacer'),
    zipIcon: $('#zip .fa'),
  };

  let context = {
    display: dom.canvas.display.getContext('2d'),
    render: dom.canvas.render.getContext('2d'),
  };

  // Download GIF
  // ============

  let imgURL = decodeURIComponent(window.location.hash.substring(1));
  let downloadReady;
  let state = {};

  // Imgur support
  if (imgURL.includes('imgur')) {
    if (imgURL.endsWith('gifv')) imgURL = imgURL.slice(0, -1);
    else if (imgURL.endsWith('mp4')) imgURL = imgURL.slice(0, -3) + 'gif';
    else if (imgURL.endsWith('webm')) imgURL = imgURL.slice(0, -4) + 'gif';
    if (!imgURL.endsWith('.gif')) imgURL += '.gif';
  }

  // Gfycat support
  if (imgURL.includes('gfycat') && !imgURL.includes('giant.gfycat')) {
    URLparts = imgURL.split('/');
    let code = URLparts[URLparts.length - 1].split('.')[0];
    if (code.endsWith('-mobile')) code = code.slice(0, -7);
    imgURL = `https://giant.gfycat.com/${code}.gif`;
  }

  let h = new XMLHttpRequest();
  h.responseType = 'arraybuffer';
  h.onload = request => downloadReady = handleGIF(request.target.response);
  h.onprogress = e => e.lengthComputable && downloadBar.set(e.loaded / e.total);
  h.onerror = showError.bind(null, imgURL);
  h.open('GET', imgURL, true);
  h.send();

  // Initialize player
  // =================

  function init() {

    // Clean up any previous scrubbing
    if (!$.isEmptyObject(state)) {
      $('#exploding-message').hide();
      $('#exploded-frames > img').remove();
      context.display.clearRect(0, 0, state.width, state.height);
    }

    // Default state
    state = {
      barWidth: null,
      currentFrame: 0,
      debug: false,
      keyFrameRate: 15, // Performance: Pre-render every n frames
      frame() { return this.frames[this.currentFrame] },
      frameDelay() { return this.frame().delayTime / Math.abs(this.speed) },
      frames: [],
      playing: false,
      playTimeoutId: null,
      scrubbing: false,
      speed: 1,
      zipGen: new JSZip(),
    };
  }

  function showError(msg) {
    dom.errorMessage.html(`<span class="error">${msg}</span>`);
  }

  function handleGIF(buffer) {

    console.timeEnd('download');
    console.time('parse');
    const bytes = new Uint8Array(buffer);
    let headerString = bytes.subarray(0, 3).string();
    if (headerString !== 'GIF') return showError('Error: Not a GIF image.');

    init();

    // Image dimensions
    const dimensions = new Uint16Array(buffer, 6, 2);
    [state.width, state.height] = dimensions;
    dom.canvas.render.width = dom.canvas.display.width = state.width;
    dom.canvas.render.height = dom.canvas.display.height = state.height;
    dom.bar[0].style.width = dom.line[0].style.width = 
      state.barWidth = Math.max(state.width, 450);
    $('#content').css({ width: state.barWidth, height: state.height });

    // Adjust window size
    if (!localBool('open-tabs')) {
      chrome.windows.getCurrent((win) => {
        chrome.windows.update(win.id, {
          width: Math.max(state.width + 180, 640),
          height: Math.min(Math.max(state.height + 300, 410), 850),
        });
      });
    }
    
    // Record global color table
    let pos = 13 + colorTableSize(bytes[10]);
    const gct = bytes.subarray(13, pos);

    state.frames = parseFrames(buffer, pos, gct, state.keyFrameRate);

    return renderKeyFrames()
      .then(showControls)
      .then(renderIntermediateFrames)
      .then(explodeFrames)
      .catch(err => console.log('Rendering GIF failed!', err));
  }

  const chainPromises = [(x, y) => x.then(y), Promise.resolve()];

  function renderKeyFrames() {
    console.timeEnd('parse');
    console.time('render-keyframes');
    return state.frames
      .map(frame => () => {
        return createImageBitmap(frame.blob)
          .then(bitmap => { frame.drawable = bitmap; return frame })
          .then(renderFrame);
      })
      .reduce(...chainPromises);
  }

  function renderIntermediateFrames() {
    console.time('background-render');
    return state.frames
      .map(frame => () => renderFrame(frame, true))
      .reduce(...chainPromises);
  }


  function explodeFrames() {
    console.timeEnd('background-render');
    state.frames.map(x => dom.explodedFrames.append(x.drawable));
    $('#exploding-message').hide();
  }

  // Keyboard and mouse controls
  // ===========================

  function showControls() {
    console.timeEnd('render-keyframes');
    dom.bar.show();
    dom.speedList.show();
    $('#messages').hide();
    $(dom.canvas.render).hide();
    $('#toolbar').css({display: 'flex'});
    $(dom.canvas.display).css('display','inline-block');
    dom.spacer.css({'margin-top': '-40px'});
    $('body').removeClass('flex');
    showFrame(state.currentFrame);
    localBool('auto-play') ? togglePlaying(true) : togglePlaying(false);

    $('#url').val(imgURL)
      .on('mousedown mouseup mousmove', e => e.stopPropagation())
      .on('keydown', (e) => {
        e.stopPropagation();
        if (e.keyCode === 13) {
          let url = encodeURIComponent($('#url').val());
          location.href = location.href.replace(location.hash,'') + '#' + url;
          location.reload();
        }
      });

    $(document)
      .on('mousedown', '#bubble-spacer', () => state.scrubbing = true )
      .on('mouseup', () => state.scrubbing = false )
      .on('mousemove', (e) => {
        const x = parseInt(e.pageX - dom.spacer[0].offsetLeft, 10);
        if (state.scrubbing) updateScrub(x);
      });

    document.body.onkeydown = (e) => {
      switch (e.keyCode) {
        case 8: // Backspace
        case 27: // Escape
        case 69: // E
          toggleExplodeView();
          break;
        case 32: // Space
          togglePlaying(state.playing);
          break;
        case 37: // Left Arrow
          togglePlaying(false);
          showFrame(--state.currentFrame);
          break;
        case 39: // Right Arrow
          togglePlaying(false);
          showFrame(++state.currentFrame);
          break;
        case 79: // O
          options();
          break;
      }
    };
  }

  // GIF parsing
  // ===========

  function colorTableSize(packedHeader) {
    const tableFlag = packedHeader.bits(0, 1);
    if (tableFlag !== 1) return 0;
    const size = packedHeader.bits(5, 3);
    return 3 * Math.pow(2, size + 1);
  }

  function parseFrames(buffer, pos, gct, keyFrameRate) {

    const bytes = new Uint8Array(buffer);
    const trailer = new Uint8Array([0x3B]);
    let gce, packed;
    let frames = [];

    // Rendering 87a GIFs didn't work right for some reason. 
    // Forcing the 89a header made them work.
    const headerBytes = 'GIF89a'.split('').map(x => x.charCodeAt(0), []);
    const nextBytes = bytes.subarray(6, 13);
    let header = new Uint8Array(13);
    header.set(headerBytes);
    header.set(nextBytes, 6);

    while (pos < bytes.length) {
      switch (bytes[pos]) { 
        case 0x21:
          switch (bytes[pos+1]) {
            case 0xF9: // 'Graphics control extension...'
              packed = bytes[pos+3];
              gce = {
                pos: pos,
                disposalMethod: packed.bits(3, 3),
                transparent: packed.bits(7, 1),
                delayTime: bytes[pos+4],
              };
              pos += 8;
              break;
            case 0xFE: pos -= 12; // Comment extension...
            case 0xFF: pos -= 1; // Application extension...
            case 0x01: pos += 15; // Plain Text extension...
            default: // Skip data sub-blocks
              while (bytes[pos] !== 0x00) pos += bytes[pos] + 1;
              pos++;
          }
          break;
        case 0x2C: { // `New image frame at ${pos}`
          const [x, y, w, h] = new Uint16Array(buffer.slice(pos + 1, pos + 9));
          let frame = {
            disposalMethod: gce.disposalMethod,
            delayTime: gce.delayTime < 2 ? 100 : gce.delayTime * 10,
            isKeyFrame: frames.length % keyFrameRate === 0 && !!frames.length,
            isRendered: false,
            number: frames.length + 1,
            transparent: gce.transparent,
            pos: { x, y },
            size: { w, h },
          };

          // Skip local color table
          const imageStart = pos;
          pos += colorTableSize(bytes[pos+9]) + 11;

          // Skip data blocks
          while (bytes[pos] !== 0x00) pos += bytes[pos] + 1;
          pos++;

          let imageBlocks = bytes.subarray(imageStart, pos);

          // Use a Graphics Control Extension
          if (typeof gce.pos !== 'undefined') {
            imageBlocks = bytes.subarray(gce.pos, gce.pos + 4) // Begin ext
              .concat(new Uint8Array([0x00,0x00])) // Zero out the delay time
              .concat(bytes.subarray(gce.pos + 6, gce.pos + 8)) // End ext
              .concat(imageBlocks);
          }

          const data = header.concat(gct).concat(imageBlocks).concat(trailer);
          frame.blob = new Blob([data], {type: 'image/gif'});
          frames.push(frame);
          break;
        }
        case 0x3B: // End of file
          return frames;
        default:
          return showError('Error: Could not decode GIF');
      }
    }
  }

  // Drawing to canvas
  // =================

  function canvasToBlob(canvas) {
    return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.90));
  }

  function blobToImg(blob, frame) {
    return new Promise((resolve) => {
      let blobURL = URL.createObjectURL(blob, {oneTimeOnly: true});
      let img = document.createElement('img');
      img.onload = () => {
        renderBar.set(frame.number / state.frames.length);
        frame.isRendered = true;
        resolve(frame);
      };
      img.src = blobURL;
      frame.drawable = img;
    });
  }

  function renderFrame(frame, forceKeyFrame) {

    // Disposal method 0 or 1: draw image only
    // Disposal method 2: draw image then erase portion just drawn
    // Disposal method 3: draw image then revert to previous frame
    const [{x, y}, {w, h}, method] = [frame.pos, frame.size, frame.disposalMethod];
    const full = [0, 0, state.width, state.height];
    const backup = method === 3 ? context.render.getImageData(...full) : null;
    context.render.drawImage(frame.drawable, ...full);
    if (method === 2) context.render.clearRect(x, y, w, h);
    if (method === 3) context.render.putImageData(backup, 0, 0);

    // Save keyFrames to <img> elements
    if ((frame.isKeyFrame || forceKeyFrame) && !frame.isRendered) {
      return canvasToBlob(dom.canvas.render).then((blob) => {
        return blobToImg(blob, frame);
      });
    }
  }

  function showFrame(frameNumber) {

    // Draw current frame only if it's already rendered
    const frame = state.frames[state.currentFrame = frameNumber];
    const lastFrame = state.frames.length - 1;
    dom.filler.css('left', ((frameNumber / lastFrame) * state.barWidth) - 4);
    if (frame.isRendered) return context.display.drawImage(frame.drawable, 0, 0);

    // Rendering not complete. Draw all frames since latest key frame as well
    const first = Math.max(0, frameNumber - (frameNumber % state.keyFrameRate));
    for (let i = first; i <= frameNumber; i++) {
      context.display.drawImage(state.frames[i].drawable, 0, 0);
    }
  }

  // Toolbar: explode, download, and options
  // =======================================

  function downloadZip() {
    if (dom.zipIcon.hasClass('fa-spin')) return false;
    dom.zipIcon.toggleClass('fa-download fa-spinner fa-spin');
    downloadReady.then(() => {
      state.frames.map((frame) => {
        state.zipGen.file(`Frame ${frame.number + 1}.jpg`, frame.blob);
      });
      state.zipGen.generateAsync({type: 'blob'}).then((blob) => {
        saveAs(blob, 'gif-scrubber.zip');
        dom.zipIcon.toggleClass('fa-download fa-spinner fa-spin');
      });
    });
  }

  function toggleExplodeView() {
    togglePlaying(false);
    dom.explodedFrames.add(dom.spacer).add(dom.speedList).toggle();
  }

  function options() {
    chrome.tabs.create({url: 'options.html'});
  }

  $('a').click(e => e.preventDefault());
  $('#bomb, #exploded-frames .close').on('click', toggleExplodeView);
  $('#gear').on('click', options);
  $('#zip').on('click', downloadZip);

  // Drag and drop
  // =============

  function handleDrop(e) {
    e.preventDefault();
    togglePlaying(false);
    let reader = new FileReader();
    reader.onload = e => handleGIF(e.target.result);
    reader.readAsArrayBuffer(e.dataTransfer.files[0]);
  }

  function handleDragOver(evt) {
    evt.stopPropagation();
    evt.preventDefault();
    evt.dataTransfer.dropEffect = 'copy';
  }

  document.body.addEventListener('dragover', handleDragOver, false);
  document.body.addEventListener('drop', handleDrop, false);

  // Player controls
  // ===============

  function updateScrub(mouseX) {
    togglePlaying(false);
    mouseX = Math.min(Math.max(mouseX, 0), state.barWidth - 1);
    frame = parseInt((mouseX/state.barWidth) / (1/state.frames.length), 10);
    if (frame !== state.currentFrame) showFrame(frame);
  }

  function advanceFrame() {
    let frameNumber = state.currentFrame + (state.speed > 0 ? 1 : -1);
    const loopBackward = frameNumber < 0;
    const loopForward = frameNumber >= state.frames.length;
    const lastFrame = state.frames.length - 1;

    if (loopBackward || loopForward) {
      if (localBool('loop-anim')) frameNumber = loopForward ? 0 : lastFrame;
      else frameNumber = loopForward ? lastFrame : 0;
    }

    state.playTimeoutId = setTimeout(advanceFrame, state.frameDelay());
    showFrame(frameNumber);
  }

  function togglePlaying(playing) {
    if (state.playing === playing) return;
    dom.pausePlayIcon.toggleClass('fa-pause', playing);
    if (state.playing = playing) {
      state.playTimeoutId = setTimeout(advanceFrame, state.frameDelay());
    } else {
      clearTimeout(state.playTimeoutId);
    }
  }

  dom.speeds.on('click', function() {
    if (this.id === 'play-pause') return togglePlaying(state.playing);
    state.speed = Number(this.innerText);
    togglePlaying(true);
    dom.speeds.removeClass('selected');
    $(this).addClass('selected');
  });

}, false);

// Utilities
// =========

Uint8Array.prototype.concat = function(newArr) {
  let result = new Uint8Array(this.length + newArr.length);
  result.set(this);
  result.set(newArr, this.length);
  return result;
}

Uint8Array.prototype.string = function() {
  return this.reduce((prev, curr) => prev + String.fromCharCode(curr), '');
}

Number.prototype.bits = function(startBit, length) {
  let string = this.toString(2);
  while (string.length < 8) string = '0' + string; // Zero pad
  string = string.substring(startBit, startBit + (length || 1))
  return parseInt(string, 2);
}