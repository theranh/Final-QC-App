import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  drawLiveVideoFrame,
  liveCameraCorrection,
  liveCameraProfile,
  saveLiveCameraCorrection,
} from './livePhoto';

function context() {
  return {
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
  };
}

function canvas(ctx = context()) {
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
  };
}

function video({
  videoWidth = 1920,
  videoHeight = 1080,
  clientWidth = 1600,
  clientHeight = 900,
} = {}) {
  return {
    videoWidth,
    videoHeight,
    clientWidth,
    clientHeight,
    srcObject: {
      getVideoTracks: () => [{ getSettings: () => ({ facingMode: 'environment' }) }],
    },
  };
}

describe('drawLiveVideoFrame', () => {
  let created;

  beforeEach(() => {
    created = [];
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      if (tag !== 'canvas') return {};
      const next = canvas();
      created.push(next);
      return next;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('keeps an already-upright frame unrotated', () => {
    const source = video();
    const target = canvas();

    const result = drawLiveVideoFrame(source, target, { correction: 0 });

    expect(created).toHaveLength(0);
    expect(target.getContext('2d').rotate).not.toHaveBeenCalled();
    expect(target.getContext('2d').drawImage).toHaveBeenCalledWith(
      source, 0, 0, 1920, 1080, 0, 0, 1600, 900,
    );
    expect(result).toMatchObject({ correction: 0, width: 1600, height: 900 });
  });

  it('rotates the backing frame left before preview crop and zoom', () => {
    const source = video({ clientWidth: 900, clientHeight: 1200 });
    const target = canvas();

    const result = drawLiveVideoFrame(source, target, {
      correction: -90,
      zoom: 2,
      previewWidth: 900,
      previewHeight: 1200,
    });

    expect(created).toHaveLength(1);
    const oriented = created[0];
    expect(oriented.width).toBe(1080);
    expect(oriented.height).toBe(1920);
    expect(oriented.getContext('2d').translate).toHaveBeenCalledWith(0, 1920);
    expect(oriented.getContext('2d').rotate).toHaveBeenCalledWith(-Math.PI / 2);
    expect(oriented.getContext('2d').drawImage).toHaveBeenCalledWith(
      source, 0, 0, 1920, 1080,
    );
    expect(result).toMatchObject({
      correction: -90,
      sourceWidth: 1080,
      sourceHeight: 1920,
      sx: 270,
      sy: 600,
      sw: 540,
      sh: 720,
      width: 540,
      height: 720,
    });
    expect(target.getContext('2d').drawImage).toHaveBeenCalledWith(
      oriented, 270, 600, 540, 720, 0, 0, 540, 720,
    );
  });

  it('supports right and upside-down corrections', () => {
    for (const [correction, translate, angle, dimensions] of [
      [90, [1080, 0], Math.PI / 2, [1080, 1920]],
      [180, [1920, 1080], Math.PI, [1920, 1080]],
    ]) {
      created = [];
      const target = canvas();
      drawLiveVideoFrame(video(), target, { correction });
      const oriented = created[0];
      expect(oriented.getContext('2d').translate).toHaveBeenCalledWith(...translate);
      expect(oriented.getContext('2d').rotate).toHaveBeenCalledWith(angle);
      expect([oriented.width, oriented.height]).toEqual(dimensions);
    }
  });
});

describe('live camera calibration profile', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  const iphone = {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 Version/18.2 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
    maxTouchPoints: 5,
  };

  it('requires one iPhone confirmation, then remembers the explicit correction', () => {
    const source = video({ clientWidth: 900, clientHeight: 1200 });
    const options = {
      navigatorObject: iphone,
      windowObject: { orientation: 0 },
      storage: localStorage,
    };

    const first = liveCameraCorrection(source, options);
    expect(first).toMatchObject({ correction: 0, needsReview: true });
    saveLiveCameraCorrection(first.profile, -90, localStorage);
    expect(liveCameraCorrection(source, options)).toMatchObject({
      profile: first.profile,
      correction: -90,
      needsReview: false,
    });
  });

  it('separates portrait and landscape screen mappings', () => {
    const portrait = video({ clientWidth: 900, clientHeight: 1200 });
    const landscape = video({ clientWidth: 1200, clientHeight: 900 });
    const portraitKey = liveCameraProfile(portrait, {
      navigatorObject: iphone,
      windowObject: { orientation: 0 },
    });
    const landscapeKey = liveCameraProfile(landscape, {
      navigatorObject: iphone,
      windowObject: { orientation: 90 },
    });
    expect(portraitKey).not.toBe(landscapeKey);
  });

  it('leaves non-Apple browsers on the established no-rotation path', () => {
    expect(liveCameraCorrection(video(), {
      navigatorObject: { userAgent: 'Mozilla/5.0 (Linux; Android 15)', platform: 'Linux armv8l' },
      windowObject: { screen: { orientation: { angle: 0 } } },
      storage: localStorage,
    })).toMatchObject({ correction: 0, needsReview: false });
  });

  it('keeps calibration usable when browser storage access throws', () => {
    const inaccessibleStorage = {
      getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('blocked', 'SecurityError'); },
    };
    const source = video({ clientWidth: 900, clientHeight: 1200 });
    const options = {
      navigatorObject: iphone,
      windowObject: { orientation: 0 },
      storage: inaccessibleStorage,
    };

    const calibration = liveCameraCorrection(source, options);
    expect(calibration).toMatchObject({ correction: 0, needsReview: true });
    expect(() => saveLiveCameraCorrection(
      calibration.profile,
      -90,
      inaccessibleStorage,
    )).not.toThrow();
  });
});