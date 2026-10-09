import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachMediaSource,
  canPlayHlsNatively,
  destroyHls,
  getDirectUrl,
  getHlsUrl,
  isHlsEligible,
} from "../app/lib/hls.mjs";

/** Create a minimal audio element substitute with source/load observations. */
function fakeAudio({ nativeHls = false } = {}) {
  return {
    src: "",
    loadCount: 0,
    probeCount: 0,
    /** Record native capability probes independently of source attachment. */
    canPlayType() {
      this.probeCount += 1;
      return nativeHls ? "probably" : "";
    },
    /** Record a requested native media reload. */
    load() {
      this.loadCount += 1;
    },
  };
}

/** Create a deterministic hls.js class and expose its constructed instances. */
function fakeHlsClass({ supported = true } = {}) {
  const instances = [];
  class FakeHls {
    static Events = { ERROR: "error" };
    static ErrorTypes = { NETWORK_ERROR: "network" };
    /** Return the configured browser support result. */
    static isSupported() {
      return supported;
    }

    /** Record one fake instance and its configuration. */
    constructor(config) {
      this.config = config;
      this.handlers = new Map();
      this.destroyed = false;
      instances.push(this);
    }

    /** Store an event callback for explicit test emission. */
    on(event, handler) {
      this.handlers.set(event, handler);
    }

    /** Record the selected playlist. */
    loadSource(url) {
      this.source = url;
    }

    /** Record the attached audio element. */
    attachMedia(audio) {
      this.media = audio;
    }

    /** Record deterministic teardown. */
    destroy() {
      this.destroyed = true;
    }
  }
  return { FakeHls, instances };
}

test("native HLS capability is probed once per element, including unsupported results", () => {
  for (const [name, response, expected] of [
    ["unsupported", "", false],
    ["possible native support", "maybe", true],
    ["native support", "probably", true],
  ]) {
    let probes = 0;
    const audio = {
      /** Count capability queries, which can emit browser decoder warnings. */
      canPlayType(type) {
        assert.equal(type, "application/vnd.apple.mpegurl");
        probes += 1;
        return response;
      },
    };
    for (let snapshot = 0; snapshot < 25; snapshot += 1) {
      assert.equal(canPlayHlsNatively(audio), expected, name);
    }
    assert.equal(probes, 1, name);
  }
  assert.equal(canPlayHlsNatively(null), false);
  assert.equal(canPlayHlsNatively({}), false);
});

test("HLS URL and eligibility policy covers supported and direct files", () => {
  const cases = [
    ["track.mp3", true],
    ["TRACK.M4A", true],
    ["track.txt", false],
    ["track", false],
    ["", false],
  ];
  for (const [filename, eligible] of cases) {
    assert.equal(isHlsEligible(filename), eligible, filename);
  }
  assert.equal(getDirectUrl("https://example.test", "a b.mp3"), "https://example.test/media/a%20b.mp3");
  assert.match(getHlsUrl("https://example.test", "a b.mp3"), /\/media\/hls\/a%20b\.mp3\/index\.m3u8\?v=/);
});

test("direct, native and unsupported paths avoid constructing hls.js", async () => {
  const cases = [
    ["notes.txt", false, true, "/media/notes.txt"],
    ["track.mp3", true, true, "/media/hls/track.mp3/index.m3u8"],
    ["track.mp3", false, false, "/media/track.mp3"],
  ];
  for (const [filename, nativeHls, supported, expected] of cases) {
    const audio = fakeAudio({ nativeHls });
    const hlsRef = { current: null };
    const { FakeHls, instances } = fakeHlsClass({ supported });
    const result = await attachMediaSource({
      audio,
      base: "https://example.test",
      filename,
      hlsRef,
      loadHls: async () => FakeHls,
    });
    assert.match(result, new RegExp(expected.replaceAll(".", "\\.")), filename);
    assert.equal(instances.length, 0, filename);
    assert.equal(audio.loadCount, 1, filename);
  }
});

test("lazy hls.js attachment reuses the current track and falls back on network failure", async () => {
  const audio = fakeAudio();
  const hlsRef = { current: null };
  const { FakeHls, instances } = fakeHlsClass();
  const options = {
    audio,
    base: "https://example.test",
    filename: "track.mp3",
    hlsRef,
    loadHls: async () => FakeHls,
  };
  const result = await attachMediaSource(options);
  assert.equal(result, getHlsUrl(options.base, options.filename));
  assert.equal(instances.length, 1);
  assert.equal(instances[0].source, result);
  assert.equal(instances[0].media, audio);

  for (let snapshot = 0; snapshot < 25; snapshot += 1) {
    await attachMediaSource(options);
  }
  assert.equal(instances.length, 1);
  assert.equal(audio.probeCount, 1);

  instances[0].handlers.get(FakeHls.Events.ERROR)(null, { type: FakeHls.ErrorTypes.NETWORK_ERROR });
  assert.equal(instances[0].destroyed, true);
  assert.equal(hlsRef.current, null);
  assert.equal(audio.src, getDirectUrl(options.base, options.filename));
});

test("repeated snapshots share one pending lazy attachment", async () => {
  const audio = fakeAudio();
  const hlsRef = { current: null };
  const { FakeHls, instances } = fakeHlsClass();
  let resolveModule;
  let loadCount = 0;
  const modulePromise = new Promise((resolve) => {
    resolveModule = () => resolve(FakeHls);
  });
  /** Count module requests while returning one delayed import. */
  const loadHls = () => {
    loadCount += 1;
    return modulePromise;
  };
  const options = { audio, base: "https://example.test", filename: "track.mp3", hlsRef, loadHls };
  const first = attachMediaSource(options);
  const second = attachMediaSource(options);
  assert.equal(loadCount, 1);
  resolveModule();
  assert.equal(await first, getHlsUrl(options.base, options.filename));
  assert.equal(await second, getHlsUrl(options.base, options.filename));
  assert.equal(instances.length, 1);
});

test("obsolete lazy imports cannot attach after a newer track or teardown", async () => {
  const audio = fakeAudio();
  const hlsRef = { current: null };
  const { FakeHls, instances } = fakeHlsClass();
  let resolveModule;
  const modulePromise = new Promise((resolve) => {
    resolveModule = () => resolve(FakeHls);
  });
  /** Resolve both competing attachments from one delayed module load. */
  const loadHls = () => modulePromise;

  const first = attachMediaSource({ audio, base: "https://example.test", filename: "first.mp3", hlsRef, loadHls });
  const second = attachMediaSource({ audio, base: "https://example.test", filename: "second.mp3", hlsRef, loadHls });
  resolveModule();
  assert.equal(await first, null);
  assert.match(await second, /second\.mp3/);
  assert.equal(instances.length, 1);
  assert.match(instances[0].source, /second\.mp3/);

  let resolveAfterDestroy;
  const pending = attachMediaSource({
    audio,
    base: "https://example.test",
    filename: "third.mp3",
    hlsRef,
    loadHls: () => new Promise((resolve) => {
      resolveAfterDestroy = () => resolve(FakeHls);
    }),
  });
  destroyHls(hlsRef);
  resolveAfterDestroy();
  assert.equal(await pending, null);
  assert.equal(hlsRef.current, null);
});
