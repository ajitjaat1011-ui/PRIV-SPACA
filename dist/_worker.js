var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/promise-limit/index.js
var require_promise_limit = __commonJS({
  "node_modules/promise-limit/index.js"(exports, module) {
    function limiter(count) {
      var outstanding = 0;
      var jobs = [];
      function remove() {
        outstanding--;
        if (outstanding < count) {
          dequeue();
        }
      }
      __name(remove, "remove");
      function dequeue() {
        var job = jobs.shift();
        semaphore.queue = jobs.length;
        if (job) {
          run(job.fn).then(job.resolve).catch(job.reject);
        }
      }
      __name(dequeue, "dequeue");
      function queue(fn) {
        return new Promise(function(resolve, reject) {
          jobs.push({ fn, resolve, reject });
          semaphore.queue = jobs.length;
        });
      }
      __name(queue, "queue");
      function run(fn) {
        outstanding++;
        try {
          return Promise.resolve(fn()).then(function(result) {
            remove();
            return result;
          }, function(error) {
            remove();
            throw error;
          });
        } catch (err) {
          remove();
          return Promise.reject(err);
        }
      }
      __name(run, "run");
      var semaphore = /* @__PURE__ */ __name(function(fn) {
        if (outstanding >= count) {
          return queue(fn);
        } else {
          return run(fn);
        }
      }, "semaphore");
      return semaphore;
    }
    __name(limiter, "limiter");
    function map(items, mapper) {
      var failed = false;
      var limit = this;
      return Promise.all(items.map(function() {
        var args = arguments;
        return limit(function() {
          if (!failed) {
            return mapper.apply(void 0, args).catch(function(e) {
              failed = true;
              throw e;
            });
          }
        });
      }));
    }
    __name(map, "map");
    function addExtras(fn) {
      fn.queue = 0;
      fn.map = map;
      return fn;
    }
    __name(addExtras, "addExtras");
    module.exports = function(count) {
      if (count) {
        return addExtras(limiter(count));
      } else {
        return addExtras(function(fn) {
          return fn();
        });
      }
    };
  }
});

// node_modules/bcryptjs/dist/bcrypt.js
var require_bcrypt = __commonJS({
  "node_modules/bcryptjs/dist/bcrypt.js"(exports, module) {
    (function(global2, factory) {
      if (typeof define === "function" && define["amd"])
        define([], factory);
      else if (typeof __require === "function" && typeof module === "object" && module && module["exports"])
        module["exports"] = factory();
      else
        (global2["dcodeIO"] = global2["dcodeIO"] || {})["bcrypt"] = factory();
    })(exports, function() {
      "use strict";
      var bcrypt2 = {};
      var randomFallback = null;
      function random(len) {
        if (typeof module !== "undefined" && module && module["exports"])
          try {
            return __require("crypto")["randomBytes"](len);
          } catch (e) {
          }
        try {
          var a;
          (self["crypto"] || self["msCrypto"])["getRandomValues"](a = new Uint32Array(len));
          return Array.prototype.slice.call(a);
        } catch (e) {
        }
        if (!randomFallback)
          throw Error("Neither WebCryptoAPI nor a crypto module is available. Use bcrypt.setRandomFallback to set an alternative");
        return randomFallback(len);
      }
      __name(random, "random");
      var randomAvailable = false;
      try {
        random(1);
        randomAvailable = true;
      } catch (e) {
      }
      randomFallback = null;
      bcrypt2.setRandomFallback = function(random2) {
        randomFallback = random2;
      };
      bcrypt2.genSaltSync = function(rounds, seed_length) {
        rounds = rounds || GENSALT_DEFAULT_LOG2_ROUNDS;
        if (typeof rounds !== "number")
          throw Error("Illegal arguments: " + typeof rounds + ", " + typeof seed_length);
        if (rounds < 4)
          rounds = 4;
        else if (rounds > 31)
          rounds = 31;
        var salt = [];
        salt.push("$2a$");
        if (rounds < 10)
          salt.push("0");
        salt.push(rounds.toString());
        salt.push("$");
        salt.push(base64_encode(random(BCRYPT_SALT_LEN), BCRYPT_SALT_LEN));
        return salt.join("");
      };
      bcrypt2.genSalt = function(rounds, seed_length, callback) {
        if (typeof seed_length === "function")
          callback = seed_length, seed_length = void 0;
        if (typeof rounds === "function")
          callback = rounds, rounds = void 0;
        if (typeof rounds === "undefined")
          rounds = GENSALT_DEFAULT_LOG2_ROUNDS;
        else if (typeof rounds !== "number")
          throw Error("illegal arguments: " + typeof rounds);
        function _async(callback2) {
          nextTick(function() {
            try {
              callback2(null, bcrypt2.genSaltSync(rounds));
            } catch (err) {
              callback2(err);
            }
          });
        }
        __name(_async, "_async");
        if (callback) {
          if (typeof callback !== "function")
            throw Error("Illegal callback: " + typeof callback);
          _async(callback);
        } else
          return new Promise(function(resolve, reject) {
            _async(function(err, res) {
              if (err) {
                reject(err);
                return;
              }
              resolve(res);
            });
          });
      };
      bcrypt2.hashSync = function(s, salt) {
        if (typeof salt === "undefined")
          salt = GENSALT_DEFAULT_LOG2_ROUNDS;
        if (typeof salt === "number")
          salt = bcrypt2.genSaltSync(salt);
        if (typeof s !== "string" || typeof salt !== "string")
          throw Error("Illegal arguments: " + typeof s + ", " + typeof salt);
        return _hash(s, salt);
      };
      bcrypt2.hash = function(s, salt, callback, progressCallback) {
        function _async(callback2) {
          if (typeof s === "string" && typeof salt === "number")
            bcrypt2.genSalt(salt, function(err, salt2) {
              _hash(s, salt2, callback2, progressCallback);
            });
          else if (typeof s === "string" && typeof salt === "string")
            _hash(s, salt, callback2, progressCallback);
          else
            nextTick(callback2.bind(this, Error("Illegal arguments: " + typeof s + ", " + typeof salt)));
        }
        __name(_async, "_async");
        if (callback) {
          if (typeof callback !== "function")
            throw Error("Illegal callback: " + typeof callback);
          _async(callback);
        } else
          return new Promise(function(resolve, reject) {
            _async(function(err, res) {
              if (err) {
                reject(err);
                return;
              }
              resolve(res);
            });
          });
      };
      function safeStringCompare(known, unknown) {
        var right = 0, wrong = 0;
        for (var i = 0, k = known.length; i < k; ++i) {
          if (known.charCodeAt(i) === unknown.charCodeAt(i))
            ++right;
          else
            ++wrong;
        }
        if (right < 0)
          return false;
        return wrong === 0;
      }
      __name(safeStringCompare, "safeStringCompare");
      bcrypt2.compareSync = function(s, hash) {
        if (typeof s !== "string" || typeof hash !== "string")
          throw Error("Illegal arguments: " + typeof s + ", " + typeof hash);
        if (hash.length !== 60)
          return false;
        return safeStringCompare(bcrypt2.hashSync(s, hash.substr(0, hash.length - 31)), hash);
      };
      bcrypt2.compare = function(s, hash, callback, progressCallback) {
        function _async(callback2) {
          if (typeof s !== "string" || typeof hash !== "string") {
            nextTick(callback2.bind(this, Error("Illegal arguments: " + typeof s + ", " + typeof hash)));
            return;
          }
          if (hash.length !== 60) {
            nextTick(callback2.bind(this, null, false));
            return;
          }
          bcrypt2.hash(s, hash.substr(0, 29), function(err, comp) {
            if (err)
              callback2(err);
            else
              callback2(null, safeStringCompare(comp, hash));
          }, progressCallback);
        }
        __name(_async, "_async");
        if (callback) {
          if (typeof callback !== "function")
            throw Error("Illegal callback: " + typeof callback);
          _async(callback);
        } else
          return new Promise(function(resolve, reject) {
            _async(function(err, res) {
              if (err) {
                reject(err);
                return;
              }
              resolve(res);
            });
          });
      };
      bcrypt2.getRounds = function(hash) {
        if (typeof hash !== "string")
          throw Error("Illegal arguments: " + typeof hash);
        return parseInt(hash.split("$")[2], 10);
      };
      bcrypt2.getSalt = function(hash) {
        if (typeof hash !== "string")
          throw Error("Illegal arguments: " + typeof hash);
        if (hash.length !== 60)
          throw Error("Illegal hash length: " + hash.length + " != 60");
        return hash.substring(0, 29);
      };
      var nextTick = typeof process !== "undefined" && process && typeof process.nextTick === "function" ? typeof setImmediate === "function" ? setImmediate : process.nextTick : setTimeout;
      function stringToBytes(str) {
        var out = [], i = 0;
        utfx.encodeUTF16toUTF8(function() {
          if (i >= str.length) return null;
          return str.charCodeAt(i++);
        }, function(b) {
          out.push(b);
        });
        return out;
      }
      __name(stringToBytes, "stringToBytes");
      var BASE64_CODE = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split("");
      var BASE64_INDEX = [
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        0,
        1,
        54,
        55,
        56,
        57,
        58,
        59,
        60,
        61,
        62,
        63,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        11,
        12,
        13,
        14,
        15,
        16,
        17,
        18,
        19,
        20,
        21,
        22,
        23,
        24,
        25,
        26,
        27,
        -1,
        -1,
        -1,
        -1,
        -1,
        -1,
        28,
        29,
        30,
        31,
        32,
        33,
        34,
        35,
        36,
        37,
        38,
        39,
        40,
        41,
        42,
        43,
        44,
        45,
        46,
        47,
        48,
        49,
        50,
        51,
        52,
        53,
        -1,
        -1,
        -1,
        -1,
        -1
      ];
      var stringFromCharCode = String.fromCharCode;
      function base64_encode(b, len) {
        var off = 0, rs = [], c1, c2;
        if (len <= 0 || len > b.length)
          throw Error("Illegal len: " + len);
        while (off < len) {
          c1 = b[off++] & 255;
          rs.push(BASE64_CODE[c1 >> 2 & 63]);
          c1 = (c1 & 3) << 4;
          if (off >= len) {
            rs.push(BASE64_CODE[c1 & 63]);
            break;
          }
          c2 = b[off++] & 255;
          c1 |= c2 >> 4 & 15;
          rs.push(BASE64_CODE[c1 & 63]);
          c1 = (c2 & 15) << 2;
          if (off >= len) {
            rs.push(BASE64_CODE[c1 & 63]);
            break;
          }
          c2 = b[off++] & 255;
          c1 |= c2 >> 6 & 3;
          rs.push(BASE64_CODE[c1 & 63]);
          rs.push(BASE64_CODE[c2 & 63]);
        }
        return rs.join("");
      }
      __name(base64_encode, "base64_encode");
      function base64_decode(s, len) {
        var off = 0, slen = s.length, olen = 0, rs = [], c1, c2, c3, c4, o, code;
        if (len <= 0)
          throw Error("Illegal len: " + len);
        while (off < slen - 1 && olen < len) {
          code = s.charCodeAt(off++);
          c1 = code < BASE64_INDEX.length ? BASE64_INDEX[code] : -1;
          code = s.charCodeAt(off++);
          c2 = code < BASE64_INDEX.length ? BASE64_INDEX[code] : -1;
          if (c1 == -1 || c2 == -1)
            break;
          o = c1 << 2 >>> 0;
          o |= (c2 & 48) >> 4;
          rs.push(stringFromCharCode(o));
          if (++olen >= len || off >= slen)
            break;
          code = s.charCodeAt(off++);
          c3 = code < BASE64_INDEX.length ? BASE64_INDEX[code] : -1;
          if (c3 == -1)
            break;
          o = (c2 & 15) << 4 >>> 0;
          o |= (c3 & 60) >> 2;
          rs.push(stringFromCharCode(o));
          if (++olen >= len || off >= slen)
            break;
          code = s.charCodeAt(off++);
          c4 = code < BASE64_INDEX.length ? BASE64_INDEX[code] : -1;
          o = (c3 & 3) << 6 >>> 0;
          o |= c4;
          rs.push(stringFromCharCode(o));
          ++olen;
        }
        var res = [];
        for (off = 0; off < olen; off++)
          res.push(rs[off].charCodeAt(0));
        return res;
      }
      __name(base64_decode, "base64_decode");
      var utfx = (function() {
        "use strict";
        var utfx2 = {};
        utfx2.MAX_CODEPOINT = 1114111;
        utfx2.encodeUTF8 = function(src, dst) {
          var cp = null;
          if (typeof src === "number")
            cp = src, src = /* @__PURE__ */ __name(function() {
              return null;
            }, "src");
          while (cp !== null || (cp = src()) !== null) {
            if (cp < 128)
              dst(cp & 127);
            else if (cp < 2048)
              dst(cp >> 6 & 31 | 192), dst(cp & 63 | 128);
            else if (cp < 65536)
              dst(cp >> 12 & 15 | 224), dst(cp >> 6 & 63 | 128), dst(cp & 63 | 128);
            else
              dst(cp >> 18 & 7 | 240), dst(cp >> 12 & 63 | 128), dst(cp >> 6 & 63 | 128), dst(cp & 63 | 128);
            cp = null;
          }
        };
        utfx2.decodeUTF8 = function(src, dst) {
          var a, b, c, d, fail = /* @__PURE__ */ __name(function(b2) {
            b2 = b2.slice(0, b2.indexOf(null));
            var err = Error(b2.toString());
            err.name = "TruncatedError";
            err["bytes"] = b2;
            throw err;
          }, "fail");
          while ((a = src()) !== null) {
            if ((a & 128) === 0)
              dst(a);
            else if ((a & 224) === 192)
              (b = src()) === null && fail([a, b]), dst((a & 31) << 6 | b & 63);
            else if ((a & 240) === 224)
              ((b = src()) === null || (c = src()) === null) && fail([a, b, c]), dst((a & 15) << 12 | (b & 63) << 6 | c & 63);
            else if ((a & 248) === 240)
              ((b = src()) === null || (c = src()) === null || (d = src()) === null) && fail([a, b, c, d]), dst((a & 7) << 18 | (b & 63) << 12 | (c & 63) << 6 | d & 63);
            else throw RangeError("Illegal starting byte: " + a);
          }
        };
        utfx2.UTF16toUTF8 = function(src, dst) {
          var c1, c2 = null;
          while (true) {
            if ((c1 = c2 !== null ? c2 : src()) === null)
              break;
            if (c1 >= 55296 && c1 <= 57343) {
              if ((c2 = src()) !== null) {
                if (c2 >= 56320 && c2 <= 57343) {
                  dst((c1 - 55296) * 1024 + c2 - 56320 + 65536);
                  c2 = null;
                  continue;
                }
              }
            }
            dst(c1);
          }
          if (c2 !== null) dst(c2);
        };
        utfx2.UTF8toUTF16 = function(src, dst) {
          var cp = null;
          if (typeof src === "number")
            cp = src, src = /* @__PURE__ */ __name(function() {
              return null;
            }, "src");
          while (cp !== null || (cp = src()) !== null) {
            if (cp <= 65535)
              dst(cp);
            else
              cp -= 65536, dst((cp >> 10) + 55296), dst(cp % 1024 + 56320);
            cp = null;
          }
        };
        utfx2.encodeUTF16toUTF8 = function(src, dst) {
          utfx2.UTF16toUTF8(src, function(cp) {
            utfx2.encodeUTF8(cp, dst);
          });
        };
        utfx2.decodeUTF8toUTF16 = function(src, dst) {
          utfx2.decodeUTF8(src, function(cp) {
            utfx2.UTF8toUTF16(cp, dst);
          });
        };
        utfx2.calculateCodePoint = function(cp) {
          return cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
        };
        utfx2.calculateUTF8 = function(src) {
          var cp, l = 0;
          while ((cp = src()) !== null)
            l += utfx2.calculateCodePoint(cp);
          return l;
        };
        utfx2.calculateUTF16asUTF8 = function(src) {
          var n = 0, l = 0;
          utfx2.UTF16toUTF8(src, function(cp) {
            ++n;
            l += utfx2.calculateCodePoint(cp);
          });
          return [n, l];
        };
        return utfx2;
      })();
      Date.now = Date.now || function() {
        return +/* @__PURE__ */ new Date();
      };
      var BCRYPT_SALT_LEN = 16;
      var GENSALT_DEFAULT_LOG2_ROUNDS = 10;
      var BLOWFISH_NUM_ROUNDS = 16;
      var MAX_EXECUTION_TIME = 100;
      var P_ORIG = [
        608135816,
        2242054355,
        320440878,
        57701188,
        2752067618,
        698298832,
        137296536,
        3964562569,
        1160258022,
        953160567,
        3193202383,
        887688300,
        3232508343,
        3380367581,
        1065670069,
        3041331479,
        2450970073,
        2306472731
      ];
      var S_ORIG = [
        3509652390,
        2564797868,
        805139163,
        3491422135,
        3101798381,
        1780907670,
        3128725573,
        4046225305,
        614570311,
        3012652279,
        134345442,
        2240740374,
        1667834072,
        1901547113,
        2757295779,
        4103290238,
        227898511,
        1921955416,
        1904987480,
        2182433518,
        2069144605,
        3260701109,
        2620446009,
        720527379,
        3318853667,
        677414384,
        3393288472,
        3101374703,
        2390351024,
        1614419982,
        1822297739,
        2954791486,
        3608508353,
        3174124327,
        2024746970,
        1432378464,
        3864339955,
        2857741204,
        1464375394,
        1676153920,
        1439316330,
        715854006,
        3033291828,
        289532110,
        2706671279,
        2087905683,
        3018724369,
        1668267050,
        732546397,
        1947742710,
        3462151702,
        2609353502,
        2950085171,
        1814351708,
        2050118529,
        680887927,
        999245976,
        1800124847,
        3300911131,
        1713906067,
        1641548236,
        4213287313,
        1216130144,
        1575780402,
        4018429277,
        3917837745,
        3693486850,
        3949271944,
        596196993,
        3549867205,
        258830323,
        2213823033,
        772490370,
        2760122372,
        1774776394,
        2652871518,
        566650946,
        4142492826,
        1728879713,
        2882767088,
        1783734482,
        3629395816,
        2517608232,
        2874225571,
        1861159788,
        326777828,
        3124490320,
        2130389656,
        2716951837,
        967770486,
        1724537150,
        2185432712,
        2364442137,
        1164943284,
        2105845187,
        998989502,
        3765401048,
        2244026483,
        1075463327,
        1455516326,
        1322494562,
        910128902,
        469688178,
        1117454909,
        936433444,
        3490320968,
        3675253459,
        1240580251,
        122909385,
        2157517691,
        634681816,
        4142456567,
        3825094682,
        3061402683,
        2540495037,
        79693498,
        3249098678,
        1084186820,
        1583128258,
        426386531,
        1761308591,
        1047286709,
        322548459,
        995290223,
        1845252383,
        2603652396,
        3431023940,
        2942221577,
        3202600964,
        3727903485,
        1712269319,
        422464435,
        3234572375,
        1170764815,
        3523960633,
        3117677531,
        1434042557,
        442511882,
        3600875718,
        1076654713,
        1738483198,
        4213154764,
        2393238008,
        3677496056,
        1014306527,
        4251020053,
        793779912,
        2902807211,
        842905082,
        4246964064,
        1395751752,
        1040244610,
        2656851899,
        3396308128,
        445077038,
        3742853595,
        3577915638,
        679411651,
        2892444358,
        2354009459,
        1767581616,
        3150600392,
        3791627101,
        3102740896,
        284835224,
        4246832056,
        1258075500,
        768725851,
        2589189241,
        3069724005,
        3532540348,
        1274779536,
        3789419226,
        2764799539,
        1660621633,
        3471099624,
        4011903706,
        913787905,
        3497959166,
        737222580,
        2514213453,
        2928710040,
        3937242737,
        1804850592,
        3499020752,
        2949064160,
        2386320175,
        2390070455,
        2415321851,
        4061277028,
        2290661394,
        2416832540,
        1336762016,
        1754252060,
        3520065937,
        3014181293,
        791618072,
        3188594551,
        3933548030,
        2332172193,
        3852520463,
        3043980520,
        413987798,
        3465142937,
        3030929376,
        4245938359,
        2093235073,
        3534596313,
        375366246,
        2157278981,
        2479649556,
        555357303,
        3870105701,
        2008414854,
        3344188149,
        4221384143,
        3956125452,
        2067696032,
        3594591187,
        2921233993,
        2428461,
        544322398,
        577241275,
        1471733935,
        610547355,
        4027169054,
        1432588573,
        1507829418,
        2025931657,
        3646575487,
        545086370,
        48609733,
        2200306550,
        1653985193,
        298326376,
        1316178497,
        3007786442,
        2064951626,
        458293330,
        2589141269,
        3591329599,
        3164325604,
        727753846,
        2179363840,
        146436021,
        1461446943,
        4069977195,
        705550613,
        3059967265,
        3887724982,
        4281599278,
        3313849956,
        1404054877,
        2845806497,
        146425753,
        1854211946,
        1266315497,
        3048417604,
        3681880366,
        3289982499,
        290971e4,
        1235738493,
        2632868024,
        2414719590,
        3970600049,
        1771706367,
        1449415276,
        3266420449,
        422970021,
        1963543593,
        2690192192,
        3826793022,
        1062508698,
        1531092325,
        1804592342,
        2583117782,
        2714934279,
        4024971509,
        1294809318,
        4028980673,
        1289560198,
        2221992742,
        1669523910,
        35572830,
        157838143,
        1052438473,
        1016535060,
        1802137761,
        1753167236,
        1386275462,
        3080475397,
        2857371447,
        1040679964,
        2145300060,
        2390574316,
        1461121720,
        2956646967,
        4031777805,
        4028374788,
        33600511,
        2920084762,
        1018524850,
        629373528,
        3691585981,
        3515945977,
        2091462646,
        2486323059,
        586499841,
        988145025,
        935516892,
        3367335476,
        2599673255,
        2839830854,
        265290510,
        3972581182,
        2759138881,
        3795373465,
        1005194799,
        847297441,
        406762289,
        1314163512,
        1332590856,
        1866599683,
        4127851711,
        750260880,
        613907577,
        1450815602,
        3165620655,
        3734664991,
        3650291728,
        3012275730,
        3704569646,
        1427272223,
        778793252,
        1343938022,
        2676280711,
        2052605720,
        1946737175,
        3164576444,
        3914038668,
        3967478842,
        3682934266,
        1661551462,
        3294938066,
        4011595847,
        840292616,
        3712170807,
        616741398,
        312560963,
        711312465,
        1351876610,
        322626781,
        1910503582,
        271666773,
        2175563734,
        1594956187,
        70604529,
        3617834859,
        1007753275,
        1495573769,
        4069517037,
        2549218298,
        2663038764,
        504708206,
        2263041392,
        3941167025,
        2249088522,
        1514023603,
        1998579484,
        1312622330,
        694541497,
        2582060303,
        2151582166,
        1382467621,
        776784248,
        2618340202,
        3323268794,
        2497899128,
        2784771155,
        503983604,
        4076293799,
        907881277,
        423175695,
        432175456,
        1378068232,
        4145222326,
        3954048622,
        3938656102,
        3820766613,
        2793130115,
        2977904593,
        26017576,
        3274890735,
        3194772133,
        1700274565,
        1756076034,
        4006520079,
        3677328699,
        720338349,
        1533947780,
        354530856,
        688349552,
        3973924725,
        1637815568,
        332179504,
        3949051286,
        53804574,
        2852348879,
        3044236432,
        1282449977,
        3583942155,
        3416972820,
        4006381244,
        1617046695,
        2628476075,
        3002303598,
        1686838959,
        431878346,
        2686675385,
        1700445008,
        1080580658,
        1009431731,
        832498133,
        3223435511,
        2605976345,
        2271191193,
        2516031870,
        1648197032,
        4164389018,
        2548247927,
        300782431,
        375919233,
        238389289,
        3353747414,
        2531188641,
        2019080857,
        1475708069,
        455242339,
        2609103871,
        448939670,
        3451063019,
        1395535956,
        2413381860,
        1841049896,
        1491858159,
        885456874,
        4264095073,
        4001119347,
        1565136089,
        3898914787,
        1108368660,
        540939232,
        1173283510,
        2745871338,
        3681308437,
        4207628240,
        3343053890,
        4016749493,
        1699691293,
        1103962373,
        3625875870,
        2256883143,
        3830138730,
        1031889488,
        3479347698,
        1535977030,
        4236805024,
        3251091107,
        2132092099,
        1774941330,
        1199868427,
        1452454533,
        157007616,
        2904115357,
        342012276,
        595725824,
        1480756522,
        206960106,
        497939518,
        591360097,
        863170706,
        2375253569,
        3596610801,
        1814182875,
        2094937945,
        3421402208,
        1082520231,
        3463918190,
        2785509508,
        435703966,
        3908032597,
        1641649973,
        2842273706,
        3305899714,
        1510255612,
        2148256476,
        2655287854,
        3276092548,
        4258621189,
        236887753,
        3681803219,
        274041037,
        1734335097,
        3815195456,
        3317970021,
        1899903192,
        1026095262,
        4050517792,
        356393447,
        2410691914,
        3873677099,
        3682840055,
        3913112168,
        2491498743,
        4132185628,
        2489919796,
        1091903735,
        1979897079,
        3170134830,
        3567386728,
        3557303409,
        857797738,
        1136121015,
        1342202287,
        507115054,
        2535736646,
        337727348,
        3213592640,
        1301675037,
        2528481711,
        1895095763,
        1721773893,
        3216771564,
        62756741,
        2142006736,
        835421444,
        2531993523,
        1442658625,
        3659876326,
        2882144922,
        676362277,
        1392781812,
        170690266,
        3921047035,
        1759253602,
        3611846912,
        1745797284,
        664899054,
        1329594018,
        3901205900,
        3045908486,
        2062866102,
        2865634940,
        3543621612,
        3464012697,
        1080764994,
        553557557,
        3656615353,
        3996768171,
        991055499,
        499776247,
        1265440854,
        648242737,
        3940784050,
        980351604,
        3713745714,
        1749149687,
        3396870395,
        4211799374,
        3640570775,
        1161844396,
        3125318951,
        1431517754,
        545492359,
        4268468663,
        3499529547,
        1437099964,
        2702547544,
        3433638243,
        2581715763,
        2787789398,
        1060185593,
        1593081372,
        2418618748,
        4260947970,
        69676912,
        2159744348,
        86519011,
        2512459080,
        3838209314,
        1220612927,
        3339683548,
        133810670,
        1090789135,
        1078426020,
        1569222167,
        845107691,
        3583754449,
        4072456591,
        1091646820,
        628848692,
        1613405280,
        3757631651,
        526609435,
        236106946,
        48312990,
        2942717905,
        3402727701,
        1797494240,
        859738849,
        992217954,
        4005476642,
        2243076622,
        3870952857,
        3732016268,
        765654824,
        3490871365,
        2511836413,
        1685915746,
        3888969200,
        1414112111,
        2273134842,
        3281911079,
        4080962846,
        172450625,
        2569994100,
        980381355,
        4109958455,
        2819808352,
        2716589560,
        2568741196,
        3681446669,
        3329971472,
        1835478071,
        660984891,
        3704678404,
        4045999559,
        3422617507,
        3040415634,
        1762651403,
        1719377915,
        3470491036,
        2693910283,
        3642056355,
        3138596744,
        1364962596,
        2073328063,
        1983633131,
        926494387,
        3423689081,
        2150032023,
        4096667949,
        1749200295,
        3328846651,
        309677260,
        2016342300,
        1779581495,
        3079819751,
        111262694,
        1274766160,
        443224088,
        298511866,
        1025883608,
        3806446537,
        1145181785,
        168956806,
        3641502830,
        3584813610,
        1689216846,
        3666258015,
        3200248200,
        1692713982,
        2646376535,
        4042768518,
        1618508792,
        1610833997,
        3523052358,
        4130873264,
        2001055236,
        3610705100,
        2202168115,
        4028541809,
        2961195399,
        1006657119,
        2006996926,
        3186142756,
        1430667929,
        3210227297,
        1314452623,
        4074634658,
        4101304120,
        2273951170,
        1399257539,
        3367210612,
        3027628629,
        1190975929,
        2062231137,
        2333990788,
        2221543033,
        2438960610,
        1181637006,
        548689776,
        2362791313,
        3372408396,
        3104550113,
        3145860560,
        296247880,
        1970579870,
        3078560182,
        3769228297,
        1714227617,
        3291629107,
        3898220290,
        166772364,
        1251581989,
        493813264,
        448347421,
        195405023,
        2709975567,
        677966185,
        3703036547,
        1463355134,
        2715995803,
        1338867538,
        1343315457,
        2802222074,
        2684532164,
        233230375,
        2599980071,
        2000651841,
        3277868038,
        1638401717,
        4028070440,
        3237316320,
        6314154,
        819756386,
        300326615,
        590932579,
        1405279636,
        3267499572,
        3150704214,
        2428286686,
        3959192993,
        3461946742,
        1862657033,
        1266418056,
        963775037,
        2089974820,
        2263052895,
        1917689273,
        448879540,
        3550394620,
        3981727096,
        150775221,
        3627908307,
        1303187396,
        508620638,
        2975983352,
        2726630617,
        1817252668,
        1876281319,
        1457606340,
        908771278,
        3720792119,
        3617206836,
        2455994898,
        1729034894,
        1080033504,
        976866871,
        3556439503,
        2881648439,
        1522871579,
        1555064734,
        1336096578,
        3548522304,
        2579274686,
        3574697629,
        3205460757,
        3593280638,
        3338716283,
        3079412587,
        564236357,
        2993598910,
        1781952180,
        1464380207,
        3163844217,
        3332601554,
        1699332808,
        1393555694,
        1183702653,
        3581086237,
        1288719814,
        691649499,
        2847557200,
        2895455976,
        3193889540,
        2717570544,
        1781354906,
        1676643554,
        2592534050,
        3230253752,
        1126444790,
        2770207658,
        2633158820,
        2210423226,
        2615765581,
        2414155088,
        3127139286,
        673620729,
        2805611233,
        1269405062,
        4015350505,
        3341807571,
        4149409754,
        1057255273,
        2012875353,
        2162469141,
        2276492801,
        2601117357,
        993977747,
        3918593370,
        2654263191,
        753973209,
        36408145,
        2530585658,
        25011837,
        3520020182,
        2088578344,
        530523599,
        2918365339,
        1524020338,
        1518925132,
        3760827505,
        3759777254,
        1202760957,
        3985898139,
        3906192525,
        674977740,
        4174734889,
        2031300136,
        2019492241,
        3983892565,
        4153806404,
        3822280332,
        352677332,
        2297720250,
        60907813,
        90501309,
        3286998549,
        1016092578,
        2535922412,
        2839152426,
        457141659,
        509813237,
        4120667899,
        652014361,
        1966332200,
        2975202805,
        55981186,
        2327461051,
        676427537,
        3255491064,
        2882294119,
        3433927263,
        1307055953,
        942726286,
        933058658,
        2468411793,
        3933900994,
        4215176142,
        1361170020,
        2001714738,
        2830558078,
        3274259782,
        1222529897,
        1679025792,
        2729314320,
        3714953764,
        1770335741,
        151462246,
        3013232138,
        1682292957,
        1483529935,
        471910574,
        1539241949,
        458788160,
        3436315007,
        1807016891,
        3718408830,
        978976581,
        1043663428,
        3165965781,
        1927990952,
        4200891579,
        2372276910,
        3208408903,
        3533431907,
        1412390302,
        2931980059,
        4132332400,
        1947078029,
        3881505623,
        4168226417,
        2941484381,
        1077988104,
        1320477388,
        886195818,
        18198404,
        3786409e3,
        2509781533,
        112762804,
        3463356488,
        1866414978,
        891333506,
        18488651,
        661792760,
        1628790961,
        3885187036,
        3141171499,
        876946877,
        2693282273,
        1372485963,
        791857591,
        2686433993,
        3759982718,
        3167212022,
        3472953795,
        2716379847,
        445679433,
        3561995674,
        3504004811,
        3574258232,
        54117162,
        3331405415,
        2381918588,
        3769707343,
        4154350007,
        1140177722,
        4074052095,
        668550556,
        3214352940,
        367459370,
        261225585,
        2610173221,
        4209349473,
        3468074219,
        3265815641,
        314222801,
        3066103646,
        3808782860,
        282218597,
        3406013506,
        3773591054,
        379116347,
        1285071038,
        846784868,
        2669647154,
        3771962079,
        3550491691,
        2305946142,
        453669953,
        1268987020,
        3317592352,
        3279303384,
        3744833421,
        2610507566,
        3859509063,
        266596637,
        3847019092,
        517658769,
        3462560207,
        3443424879,
        370717030,
        4247526661,
        2224018117,
        4143653529,
        4112773975,
        2788324899,
        2477274417,
        1456262402,
        2901442914,
        1517677493,
        1846949527,
        2295493580,
        3734397586,
        2176403920,
        1280348187,
        1908823572,
        3871786941,
        846861322,
        1172426758,
        3287448474,
        3383383037,
        1655181056,
        3139813346,
        901632758,
        1897031941,
        2986607138,
        3066810236,
        3447102507,
        1393639104,
        373351379,
        950779232,
        625454576,
        3124240540,
        4148612726,
        2007998917,
        544563296,
        2244738638,
        2330496472,
        2058025392,
        1291430526,
        424198748,
        50039436,
        29584100,
        3605783033,
        2429876329,
        2791104160,
        1057563949,
        3255363231,
        3075367218,
        3463963227,
        1469046755,
        985887462
      ];
      var C_ORIG = [
        1332899944,
        1700884034,
        1701343084,
        1684370003,
        1668446532,
        1869963892
      ];
      function _encipher(lr, off, P, S) {
        var n, l = lr[off], r = lr[off + 1];
        l ^= P[0];
        n = S[l >>> 24];
        n += S[256 | l >> 16 & 255];
        n ^= S[512 | l >> 8 & 255];
        n += S[768 | l & 255];
        r ^= n ^ P[1];
        n = S[r >>> 24];
        n += S[256 | r >> 16 & 255];
        n ^= S[512 | r >> 8 & 255];
        n += S[768 | r & 255];
        l ^= n ^ P[2];
        n = S[l >>> 24];
        n += S[256 | l >> 16 & 255];
        n ^= S[512 | l >> 8 & 255];
        n += S[768 | l & 255];
        r ^= n ^ P[3];
        n = S[r >>> 24];
        n += S[256 | r >> 16 & 255];
        n ^= S[512 | r >> 8 & 255];
        n += S[768 | r & 255];
        l ^= n ^ P[4];
        n = S[l >>> 24];
        n += S[256 | l >> 16 & 255];
        n ^= S[512 | l >> 8 & 255];
        n += S[768 | l & 255];
        r ^= n ^ P[5];
        n = S[r >>> 24];
        n += S[256 | r >> 16 & 255];
        n ^= S[512 | r >> 8 & 255];
        n += S[768 | r & 255];
        l ^= n ^ P[6];
        n = S[l >>> 24];
        n += S[256 | l >> 16 & 255];
        n ^= S[512 | l >> 8 & 255];
        n += S[768 | l & 255];
        r ^= n ^ P[7];
        n = S[r >>> 24];
        n += S[256 | r >> 16 & 255];
        n ^= S[512 | r >> 8 & 255];
        n += S[768 | r & 255];
        l ^= n ^ P[8];
        n = S[l >>> 24];
        n += S[256 | l >> 16 & 255];
        n ^= S[512 | l >> 8 & 255];
        n += S[768 | l & 255];
        r ^= n ^ P[9];
        n = S[r >>> 24];
        n += S[256 | r >> 16 & 255];
        n ^= S[512 | r >> 8 & 255];
        n += S[768 | r & 255];
        l ^= n ^ P[10];
        n = S[l >>> 24];
        n += S[256 | l >> 16 & 255];
        n ^= S[512 | l >> 8 & 255];
        n += S[768 | l & 255];
        r ^= n ^ P[11];
        n = S[r >>> 24];
        n += S[256 | r >> 16 & 255];
        n ^= S[512 | r >> 8 & 255];
        n += S[768 | r & 255];
        l ^= n ^ P[12];
        n = S[l >>> 24];
        n += S[256 | l >> 16 & 255];
        n ^= S[512 | l >> 8 & 255];
        n += S[768 | l & 255];
        r ^= n ^ P[13];
        n = S[r >>> 24];
        n += S[256 | r >> 16 & 255];
        n ^= S[512 | r >> 8 & 255];
        n += S[768 | r & 255];
        l ^= n ^ P[14];
        n = S[l >>> 24];
        n += S[256 | l >> 16 & 255];
        n ^= S[512 | l >> 8 & 255];
        n += S[768 | l & 255];
        r ^= n ^ P[15];
        n = S[r >>> 24];
        n += S[256 | r >> 16 & 255];
        n ^= S[512 | r >> 8 & 255];
        n += S[768 | r & 255];
        l ^= n ^ P[16];
        lr[off] = r ^ P[BLOWFISH_NUM_ROUNDS + 1];
        lr[off + 1] = l;
        return lr;
      }
      __name(_encipher, "_encipher");
      function _streamtoword(data, offp) {
        for (var i = 0, word = 0; i < 4; ++i)
          word = word << 8 | data[offp] & 255, offp = (offp + 1) % data.length;
        return { key: word, offp };
      }
      __name(_streamtoword, "_streamtoword");
      function _key(key, P, S) {
        var offset = 0, lr = [0, 0], plen = P.length, slen = S.length, sw;
        for (var i = 0; i < plen; i++)
          sw = _streamtoword(key, offset), offset = sw.offp, P[i] = P[i] ^ sw.key;
        for (i = 0; i < plen; i += 2)
          lr = _encipher(lr, 0, P, S), P[i] = lr[0], P[i + 1] = lr[1];
        for (i = 0; i < slen; i += 2)
          lr = _encipher(lr, 0, P, S), S[i] = lr[0], S[i + 1] = lr[1];
      }
      __name(_key, "_key");
      function _ekskey(data, key, P, S) {
        var offp = 0, lr = [0, 0], plen = P.length, slen = S.length, sw;
        for (var i = 0; i < plen; i++)
          sw = _streamtoword(key, offp), offp = sw.offp, P[i] = P[i] ^ sw.key;
        offp = 0;
        for (i = 0; i < plen; i += 2)
          sw = _streamtoword(data, offp), offp = sw.offp, lr[0] ^= sw.key, sw = _streamtoword(data, offp), offp = sw.offp, lr[1] ^= sw.key, lr = _encipher(lr, 0, P, S), P[i] = lr[0], P[i + 1] = lr[1];
        for (i = 0; i < slen; i += 2)
          sw = _streamtoword(data, offp), offp = sw.offp, lr[0] ^= sw.key, sw = _streamtoword(data, offp), offp = sw.offp, lr[1] ^= sw.key, lr = _encipher(lr, 0, P, S), S[i] = lr[0], S[i + 1] = lr[1];
      }
      __name(_ekskey, "_ekskey");
      function _crypt(b, salt, rounds, callback, progressCallback) {
        var cdata = C_ORIG.slice(), clen = cdata.length, err;
        if (rounds < 4 || rounds > 31) {
          err = Error("Illegal number of rounds (4-31): " + rounds);
          if (callback) {
            nextTick(callback.bind(this, err));
            return;
          } else
            throw err;
        }
        if (salt.length !== BCRYPT_SALT_LEN) {
          err = Error("Illegal salt length: " + salt.length + " != " + BCRYPT_SALT_LEN);
          if (callback) {
            nextTick(callback.bind(this, err));
            return;
          } else
            throw err;
        }
        rounds = 1 << rounds >>> 0;
        var P, S, i = 0, j;
        if (Int32Array) {
          P = new Int32Array(P_ORIG);
          S = new Int32Array(S_ORIG);
        } else {
          P = P_ORIG.slice();
          S = S_ORIG.slice();
        }
        _ekskey(salt, b, P, S);
        function next() {
          if (progressCallback)
            progressCallback(i / rounds);
          if (i < rounds) {
            var start = Date.now();
            for (; i < rounds; ) {
              i = i + 1;
              _key(b, P, S);
              _key(salt, P, S);
              if (Date.now() - start > MAX_EXECUTION_TIME)
                break;
            }
          } else {
            for (i = 0; i < 64; i++)
              for (j = 0; j < clen >> 1; j++)
                _encipher(cdata, j << 1, P, S);
            var ret = [];
            for (i = 0; i < clen; i++)
              ret.push((cdata[i] >> 24 & 255) >>> 0), ret.push((cdata[i] >> 16 & 255) >>> 0), ret.push((cdata[i] >> 8 & 255) >>> 0), ret.push((cdata[i] & 255) >>> 0);
            if (callback) {
              callback(null, ret);
              return;
            } else
              return ret;
          }
          if (callback)
            nextTick(next);
        }
        __name(next, "next");
        if (typeof callback !== "undefined") {
          next();
        } else {
          var res;
          while (true)
            if (typeof (res = next()) !== "undefined")
              return res || [];
        }
      }
      __name(_crypt, "_crypt");
      function _hash(s, salt, callback, progressCallback) {
        var err;
        if (typeof s !== "string" || typeof salt !== "string") {
          err = Error("Invalid string / salt: Not a string");
          if (callback) {
            nextTick(callback.bind(this, err));
            return;
          } else
            throw err;
        }
        var minor, offset;
        if (salt.charAt(0) !== "$" || salt.charAt(1) !== "2") {
          err = Error("Invalid salt version: " + salt.substring(0, 2));
          if (callback) {
            nextTick(callback.bind(this, err));
            return;
          } else
            throw err;
        }
        if (salt.charAt(2) === "$")
          minor = String.fromCharCode(0), offset = 3;
        else {
          minor = salt.charAt(2);
          if (minor !== "a" && minor !== "b" && minor !== "y" || salt.charAt(3) !== "$") {
            err = Error("Invalid salt revision: " + salt.substring(2, 4));
            if (callback) {
              nextTick(callback.bind(this, err));
              return;
            } else
              throw err;
          }
          offset = 4;
        }
        if (salt.charAt(offset + 2) > "$") {
          err = Error("Missing salt rounds");
          if (callback) {
            nextTick(callback.bind(this, err));
            return;
          } else
            throw err;
        }
        var r1 = parseInt(salt.substring(offset, offset + 1), 10) * 10, r2 = parseInt(salt.substring(offset + 1, offset + 2), 10), rounds = r1 + r2, real_salt = salt.substring(offset + 3, offset + 25);
        s += minor >= "a" ? "\0" : "";
        var passwordb = stringToBytes(s), saltb = base64_decode(real_salt, BCRYPT_SALT_LEN);
        function finish(bytes) {
          var res = [];
          res.push("$2");
          if (minor >= "a")
            res.push(minor);
          res.push("$");
          if (rounds < 10)
            res.push("0");
          res.push(rounds.toString());
          res.push("$");
          res.push(base64_encode(saltb, saltb.length));
          res.push(base64_encode(bytes, C_ORIG.length * 4 - 1));
          return res.join("");
        }
        __name(finish, "finish");
        if (typeof callback == "undefined")
          return finish(_crypt(passwordb, saltb, rounds));
        else {
          _crypt(passwordb, saltb, rounds, function(err2, bytes) {
            if (err2)
              callback(err2, null);
            else
              callback(null, finish(bytes));
          }, progressCallback);
        }
      }
      __name(_hash, "_hash");
      bcrypt2.encodeBase64 = base64_encode;
      bcrypt2.decodeBase64 = base64_decode;
      return bcrypt2;
    });
  }
});

// node_modules/hono/dist/compose.js
var compose = /* @__PURE__ */ __name((middleware, onError, onNotFound) => {
  return (context, next) => {
    let index = -1;
    return dispatch(0);
    async function dispatch(i) {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;
      let res;
      let isError = false;
      let handler;
      if (middleware[i]) {
        handler = middleware[i][0][0];
        context.req.routeIndex = i;
      } else {
        handler = i === middleware.length && next || void 0;
      }
      if (handler) {
        try {
          res = await handler(context, () => dispatch(i + 1));
        } catch (err) {
          if (err instanceof Error && onError) {
            context.error = err;
            res = await onError(err, context);
            isError = true;
          } else {
            throw err;
          }
        }
      } else {
        if (context.finalized === false && onNotFound) {
          res = await onNotFound(context);
        }
      }
      if (res && (context.finalized === false || isError)) {
        context.res = res;
      }
      return context;
    }
    __name(dispatch, "dispatch");
  };
}, "compose");

// node_modules/hono/dist/request/constants.js
var GET_MATCH_RESULT = /* @__PURE__ */ Symbol();

// node_modules/hono/dist/utils/body.js
var parseBody = /* @__PURE__ */ __name(async (request, options = /* @__PURE__ */ Object.create(null)) => {
  const { all = false, dot = false } = options;
  const headers = request instanceof HonoRequest ? request.raw.headers : request.headers;
  const contentType = headers.get("Content-Type");
  if (contentType?.startsWith("multipart/form-data") || contentType?.startsWith("application/x-www-form-urlencoded")) {
    return parseFormData(request, { all, dot });
  }
  return {};
}, "parseBody");
async function parseFormData(request, options) {
  const formData = await request.formData();
  if (formData) {
    return convertFormDataToBodyData(formData, options);
  }
  return {};
}
__name(parseFormData, "parseFormData");
function convertFormDataToBodyData(formData, options) {
  const form = /* @__PURE__ */ Object.create(null);
  formData.forEach((value, key) => {
    const shouldParseAllValues = options.all || key.endsWith("[]");
    if (!shouldParseAllValues) {
      form[key] = value;
    } else {
      handleParsingAllValues(form, key, value);
    }
  });
  if (options.dot) {
    Object.entries(form).forEach(([key, value]) => {
      const shouldParseDotValues = key.includes(".");
      if (shouldParseDotValues) {
        handleParsingNestedValues(form, key, value);
        delete form[key];
      }
    });
  }
  return form;
}
__name(convertFormDataToBodyData, "convertFormDataToBodyData");
var handleParsingAllValues = /* @__PURE__ */ __name((form, key, value) => {
  if (form[key] !== void 0) {
    if (Array.isArray(form[key])) {
      ;
      form[key].push(value);
    } else {
      form[key] = [form[key], value];
    }
  } else {
    if (!key.endsWith("[]")) {
      form[key] = value;
    } else {
      form[key] = [value];
    }
  }
}, "handleParsingAllValues");
var handleParsingNestedValues = /* @__PURE__ */ __name((form, key, value) => {
  if (/(?:^|\.)__proto__\./.test(key)) {
    return;
  }
  let nestedForm = form;
  const keys = key.split(".");
  keys.forEach((key2, index) => {
    if (index === keys.length - 1) {
      nestedForm[key2] = value;
    } else {
      if (!nestedForm[key2] || typeof nestedForm[key2] !== "object" || Array.isArray(nestedForm[key2]) || nestedForm[key2] instanceof File) {
        nestedForm[key2] = /* @__PURE__ */ Object.create(null);
      }
      nestedForm = nestedForm[key2];
    }
  });
}, "handleParsingNestedValues");

// node_modules/hono/dist/utils/url.js
var splitPath = /* @__PURE__ */ __name((path) => {
  const paths = path.split("/");
  if (paths[0] === "") {
    paths.shift();
  }
  return paths;
}, "splitPath");
var splitRoutingPath = /* @__PURE__ */ __name((routePath) => {
  const { groups, path } = extractGroupsFromPath(routePath);
  const paths = splitPath(path);
  return replaceGroupMarks(paths, groups);
}, "splitRoutingPath");
var extractGroupsFromPath = /* @__PURE__ */ __name((path) => {
  const groups = [];
  path = path.replace(/\{[^}]+\}/g, (match2, index) => {
    const mark = `@${index}`;
    groups.push([mark, match2]);
    return mark;
  });
  return { groups, path };
}, "extractGroupsFromPath");
var replaceGroupMarks = /* @__PURE__ */ __name((paths, groups) => {
  for (let i = groups.length - 1; i >= 0; i--) {
    const [mark] = groups[i];
    for (let j = paths.length - 1; j >= 0; j--) {
      if (paths[j].includes(mark)) {
        paths[j] = paths[j].replace(mark, groups[i][1]);
        break;
      }
    }
  }
  return paths;
}, "replaceGroupMarks");
var patternCache = {};
var getPattern = /* @__PURE__ */ __name((label, next) => {
  if (label === "*") {
    return "*";
  }
  const match2 = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
  if (match2) {
    const cacheKey = `${label}#${next}`;
    if (!patternCache[cacheKey]) {
      if (match2[2]) {
        patternCache[cacheKey] = next && next[0] !== ":" && next[0] !== "*" ? [cacheKey, match2[1], new RegExp(`^${match2[2]}(?=/${next})`)] : [label, match2[1], new RegExp(`^${match2[2]}$`)];
      } else {
        patternCache[cacheKey] = [label, match2[1], true];
      }
    }
    return patternCache[cacheKey];
  }
  return null;
}, "getPattern");
var tryDecode = /* @__PURE__ */ __name((str, decoder) => {
  try {
    return decoder(str);
  } catch {
    return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match2) => {
      try {
        return decoder(match2);
      } catch {
        return match2;
      }
    });
  }
}, "tryDecode");
var tryDecodeURI = /* @__PURE__ */ __name((str) => tryDecode(str, decodeURI), "tryDecodeURI");
var getPath = /* @__PURE__ */ __name((request) => {
  const url = request.url;
  const start = url.indexOf("/", url.indexOf(":") + 4);
  let i = start;
  for (; i < url.length; i++) {
    const charCode = url.charCodeAt(i);
    if (charCode === 37) {
      const queryIndex = url.indexOf("?", i);
      const hashIndex = url.indexOf("#", i);
      const end = queryIndex === -1 ? hashIndex === -1 ? void 0 : hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
      const path = url.slice(start, end);
      return tryDecodeURI(path.includes("%25") ? path.replace(/%25/g, "%2525") : path);
    } else if (charCode === 63 || charCode === 35) {
      break;
    }
  }
  return url.slice(start, i);
}, "getPath");
var getPathNoStrict = /* @__PURE__ */ __name((request) => {
  const result = getPath(request);
  return result.length > 1 && result.at(-1) === "/" ? result.slice(0, -1) : result;
}, "getPathNoStrict");
var mergePath = /* @__PURE__ */ __name((base, sub, ...rest) => {
  if (rest.length) {
    sub = mergePath(sub, ...rest);
  }
  return `${base?.[0] === "/" ? "" : "/"}${base}${sub === "/" ? "" : `${base?.at(-1) === "/" ? "" : "/"}${sub?.[0] === "/" ? sub.slice(1) : sub}`}`;
}, "mergePath");
var checkOptionalParameter = /* @__PURE__ */ __name((path) => {
  if (path.charCodeAt(path.length - 1) !== 63 || !path.includes(":")) {
    return null;
  }
  const segments = path.split("/");
  const results = [];
  let basePath = "";
  segments.forEach((segment) => {
    if (segment !== "" && !/\:/.test(segment)) {
      basePath += "/" + segment;
    } else if (/\:/.test(segment)) {
      if (/\?/.test(segment)) {
        if (results.length === 0 && basePath === "") {
          results.push("/");
        } else {
          results.push(basePath);
        }
        const optionalSegment = segment.replace("?", "");
        basePath += "/" + optionalSegment;
        results.push(basePath);
      } else {
        basePath += "/" + segment;
      }
    }
  });
  return results.filter((v, i, a) => a.indexOf(v) === i);
}, "checkOptionalParameter");
var _decodeURI = /* @__PURE__ */ __name((value) => {
  if (!/[%+]/.test(value)) {
    return value;
  }
  if (value.indexOf("+") !== -1) {
    value = value.replace(/\+/g, " ");
  }
  return value.indexOf("%") !== -1 ? tryDecode(value, decodeURIComponent_) : value;
}, "_decodeURI");
var _getQueryParam = /* @__PURE__ */ __name((url, key, multiple) => {
  let encoded;
  if (!multiple && key && !/[%+]/.test(key)) {
    let keyIndex2 = url.indexOf("?", 8);
    if (keyIndex2 === -1) {
      return void 0;
    }
    if (!url.startsWith(key, keyIndex2 + 1)) {
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    while (keyIndex2 !== -1) {
      const trailingKeyCode = url.charCodeAt(keyIndex2 + key.length + 1);
      if (trailingKeyCode === 61) {
        const valueIndex = keyIndex2 + key.length + 2;
        const endIndex = url.indexOf("&", valueIndex);
        return _decodeURI(url.slice(valueIndex, endIndex === -1 ? void 0 : endIndex));
      } else if (trailingKeyCode == 38 || isNaN(trailingKeyCode)) {
        return "";
      }
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    encoded = /[%+]/.test(url);
    if (!encoded) {
      return void 0;
    }
  }
  const results = {};
  encoded ??= /[%+]/.test(url);
  let keyIndex = url.indexOf("?", 8);
  while (keyIndex !== -1) {
    const nextKeyIndex = url.indexOf("&", keyIndex + 1);
    let valueIndex = url.indexOf("=", keyIndex);
    if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) {
      valueIndex = -1;
    }
    let name = url.slice(
      keyIndex + 1,
      valueIndex === -1 ? nextKeyIndex === -1 ? void 0 : nextKeyIndex : valueIndex
    );
    if (encoded) {
      name = _decodeURI(name);
    }
    keyIndex = nextKeyIndex;
    if (name === "") {
      continue;
    }
    let value;
    if (valueIndex === -1) {
      value = "";
    } else {
      value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? void 0 : nextKeyIndex);
      if (encoded) {
        value = _decodeURI(value);
      }
    }
    if (multiple) {
      if (!(results[name] && Array.isArray(results[name]))) {
        results[name] = [];
      }
      ;
      results[name].push(value);
    } else {
      results[name] ??= value;
    }
  }
  return key ? results[key] : results;
}, "_getQueryParam");
var getQueryParam = _getQueryParam;
var getQueryParams = /* @__PURE__ */ __name((url, key) => {
  return _getQueryParam(url, key, true);
}, "getQueryParams");
var decodeURIComponent_ = decodeURIComponent;

// node_modules/hono/dist/request.js
var tryDecodeURIComponent = /* @__PURE__ */ __name((str) => tryDecode(str, decodeURIComponent_), "tryDecodeURIComponent");
var HonoRequest = class {
  static {
    __name(this, "HonoRequest");
  }
  /**
   * `.raw` can get the raw Request object.
   *
   * @see {@link https://hono.dev/docs/api/request#raw}
   *
   * @example
   * ```ts
   * // For Cloudflare Workers
   * app.post('/', async (c) => {
   *   const metadata = c.req.raw.cf?.hostMetadata?
   *   ...
   * })
   * ```
   */
  raw;
  #validatedData;
  // Short name of validatedData
  #matchResult;
  routeIndex = 0;
  /**
   * `.path` can get the pathname of the request.
   *
   * @see {@link https://hono.dev/docs/api/request#path}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const pathname = c.req.path // `/about/me`
   * })
   * ```
   */
  path;
  bodyCache = {};
  constructor(request, path = "/", matchResult = [[]]) {
    this.raw = request;
    this.path = path;
    this.#matchResult = matchResult;
    this.#validatedData = {};
  }
  param(key) {
    return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams();
  }
  #getDecodedParam(key) {
    const paramKey = this.#matchResult[0][this.routeIndex][1][key];
    const param = this.#getParamValue(paramKey);
    return param && /\%/.test(param) ? tryDecodeURIComponent(param) : param;
  }
  #getAllDecodedParams() {
    const decoded = {};
    const keys = Object.keys(this.#matchResult[0][this.routeIndex][1]);
    for (const key of keys) {
      const value = this.#getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
      if (value !== void 0) {
        decoded[key] = /\%/.test(value) ? tryDecodeURIComponent(value) : value;
      }
    }
    return decoded;
  }
  #getParamValue(paramKey) {
    return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
  }
  query(key) {
    return getQueryParam(this.url, key);
  }
  queries(key) {
    return getQueryParams(this.url, key);
  }
  header(name) {
    if (name) {
      return this.raw.headers.get(name) ?? void 0;
    }
    const headerData = {};
    this.raw.headers.forEach((value, key) => {
      headerData[key] = value;
    });
    return headerData;
  }
  async parseBody(options) {
    return parseBody(this, options);
  }
  #cachedBody = /* @__PURE__ */ __name((key) => {
    const { bodyCache, raw: raw2 } = this;
    const cachedBody = bodyCache[key];
    if (cachedBody) {
      return cachedBody;
    }
    const anyCachedKey = Object.keys(bodyCache)[0];
    if (anyCachedKey) {
      return bodyCache[anyCachedKey].then((body) => {
        if (anyCachedKey === "json") {
          body = JSON.stringify(body);
        }
        return new Response(body)[key]();
      });
    }
    return bodyCache[key] = raw2[key]();
  }, "#cachedBody");
  /**
   * `.json()` can parse Request body of type `application/json`
   *
   * @see {@link https://hono.dev/docs/api/request#json}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.json()
   * })
   * ```
   */
  json() {
    return this.#cachedBody("text").then((text) => JSON.parse(text));
  }
  /**
   * `.text()` can parse Request body of type `text/plain`
   *
   * @see {@link https://hono.dev/docs/api/request#text}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.text()
   * })
   * ```
   */
  text() {
    return this.#cachedBody("text");
  }
  /**
   * `.arrayBuffer()` parse Request body as an `ArrayBuffer`
   *
   * @see {@link https://hono.dev/docs/api/request#arraybuffer}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.arrayBuffer()
   * })
   * ```
   */
  arrayBuffer() {
    return this.#cachedBody("arrayBuffer");
  }
  /**
   * `.bytes()` parses the request body as a `Uint8Array`.
   *
   * @see {@link https://hono.dev/docs/api/request#bytes}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.bytes()
   * })
   * ```
   */
  bytes() {
    return this.#cachedBody("arrayBuffer").then((buffer) => new Uint8Array(buffer));
  }
  /**
   * Parses the request body as a `Blob`.
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.blob();
   * });
   * ```
   * @see https://hono.dev/docs/api/request#blob
   */
  blob() {
    return this.#cachedBody("blob");
  }
  /**
   * Parses the request body as `FormData`.
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.formData();
   * });
   * ```
   * @see https://hono.dev/docs/api/request#formdata
   */
  formData() {
    return this.#cachedBody("formData");
  }
  /**
   * Adds validated data to the request.
   *
   * @param target - The target of the validation.
   * @param data - The validated data to add.
   */
  addValidatedData(target, data) {
    this.#validatedData[target] = data;
  }
  valid(target) {
    return this.#validatedData[target];
  }
  /**
   * `.url()` can get the request url strings.
   *
   * @see {@link https://hono.dev/docs/api/request#url}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const url = c.req.url // `http://localhost:8787/about/me`
   *   ...
   * })
   * ```
   */
  get url() {
    return this.raw.url;
  }
  /**
   * `.method()` can get the method name of the request.
   *
   * @see {@link https://hono.dev/docs/api/request#method}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const method = c.req.method // `GET`
   * })
   * ```
   */
  get method() {
    return this.raw.method;
  }
  get [GET_MATCH_RESULT]() {
    return this.#matchResult;
  }
  /**
   * `.matchedRoutes()` can return a matched route in the handler
   *
   * @deprecated
   *
   * Use matchedRoutes helper defined in "hono/route" instead.
   *
   * @see {@link https://hono.dev/docs/api/request#matchedroutes}
   *
   * @example
   * ```ts
   * app.use('*', async function logger(c, next) {
   *   await next()
   *   c.req.matchedRoutes.forEach(({ handler, method, path }, i) => {
   *     const name = handler.name || (handler.length < 2 ? '[handler]' : '[middleware]')
   *     console.log(
   *       method,
   *       ' ',
   *       path,
   *       ' '.repeat(Math.max(10 - path.length, 0)),
   *       name,
   *       i === c.req.routeIndex ? '<- respond from here' : ''
   *     )
   *   })
   * })
   * ```
   */
  get matchedRoutes() {
    return this.#matchResult[0].map(([[, route]]) => route);
  }
  /**
   * `routePath()` can retrieve the path registered within the handler
   *
   * @deprecated
   *
   * Use routePath helper defined in "hono/route" instead.
   *
   * @see {@link https://hono.dev/docs/api/request#routepath}
   *
   * @example
   * ```ts
   * app.get('/posts/:id', (c) => {
   *   return c.json({ path: c.req.routePath })
   * })
   * ```
   */
  get routePath() {
    return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path;
  }
};

// node_modules/hono/dist/utils/html.js
var HtmlEscapedCallbackPhase = {
  Stringify: 1,
  BeforeStream: 2,
  Stream: 3
};
var raw = /* @__PURE__ */ __name((value, callbacks) => {
  const escapedString = new String(value);
  escapedString.isEscaped = true;
  escapedString.callbacks = callbacks;
  return escapedString;
}, "raw");
var resolveCallback = /* @__PURE__ */ __name(async (str, phase, preserveCallbacks, context, buffer) => {
  if (typeof str === "object" && !(str instanceof String)) {
    if (!(str instanceof Promise)) {
      str = str.toString();
    }
    if (str instanceof Promise) {
      str = await str;
    }
  }
  const callbacks = str.callbacks;
  if (!callbacks?.length) {
    return Promise.resolve(str);
  }
  if (buffer) {
    buffer[0] += str;
  } else {
    buffer = [str];
  }
  const resStr = Promise.all(callbacks.map((c) => c({ phase, buffer, context }))).then(
    (res) => Promise.all(
      res.filter(Boolean).map((str2) => resolveCallback(str2, phase, false, context, buffer))
    ).then(() => buffer[0])
  );
  if (preserveCallbacks) {
    return raw(await resStr, callbacks);
  } else {
    return resStr;
  }
}, "resolveCallback");

// node_modules/hono/dist/context.js
var TEXT_PLAIN = "text/plain; charset=UTF-8";
var setDefaultContentType = /* @__PURE__ */ __name((contentType, headers) => {
  return {
    "Content-Type": contentType,
    ...headers
  };
}, "setDefaultContentType");
var createResponseInstance = /* @__PURE__ */ __name((body, init) => new Response(body, init), "createResponseInstance");
var Context = class {
  static {
    __name(this, "Context");
  }
  #rawRequest;
  #req;
  /**
   * `.env` can get bindings (environment variables, secrets, KV namespaces, D1 database, R2 bucket etc.) in Cloudflare Workers.
   *
   * @see {@link https://hono.dev/docs/api/context#env}
   *
   * @example
   * ```ts
   * // Environment object for Cloudflare Workers
   * app.get('*', async c => {
   *   const counter = c.env.COUNTER
   * })
   * ```
   */
  env = {};
  #var;
  finalized = false;
  /**
   * `.error` can get the error object from the middleware if the Handler throws an error.
   *
   * @see {@link https://hono.dev/docs/api/context#error}
   *
   * @example
   * ```ts
   * app.use('*', async (c, next) => {
   *   await next()
   *   if (c.error) {
   *     // do something...
   *   }
   * })
   * ```
   */
  error;
  #status;
  #executionCtx;
  #res;
  #layout;
  #renderer;
  #notFoundHandler;
  #preparedHeaders;
  #matchResult;
  #path;
  /**
   * Creates an instance of the Context class.
   *
   * @param req - The Request object.
   * @param options - Optional configuration options for the context.
   */
  constructor(req, options) {
    this.#rawRequest = req;
    if (options) {
      this.#executionCtx = options.executionCtx;
      this.env = options.env;
      this.#notFoundHandler = options.notFoundHandler;
      this.#path = options.path;
      this.#matchResult = options.matchResult;
    }
  }
  /**
   * `.req` is the instance of {@link HonoRequest}.
   */
  get req() {
    this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult);
    return this.#req;
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#event}
   * The FetchEvent associated with the current request.
   *
   * @throws Will throw an error if the context does not have a FetchEvent.
   */
  get event() {
    if (this.#executionCtx && "respondWith" in this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no FetchEvent");
    }
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#executionctx}
   * The ExecutionContext associated with the current request.
   *
   * @throws Will throw an error if the context does not have an ExecutionContext.
   */
  get executionCtx() {
    if (this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no ExecutionContext");
    }
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#res}
   * The Response object for the current request.
   */
  get res() {
    return this.#res ||= createResponseInstance(null, {
      headers: this.#preparedHeaders ??= new Headers()
    });
  }
  /**
   * Sets the Response object for the current request.
   *
   * @param _res - The Response object to set.
   */
  set res(_res) {
    if (this.#res && _res) {
      _res = createResponseInstance(_res.body, _res);
      for (const [k, v] of this.#res.headers.entries()) {
        if (k === "content-type") {
          continue;
        }
        if (k === "set-cookie") {
          const cookies = this.#res.headers.getSetCookie();
          _res.headers.delete("set-cookie");
          for (const cookie of cookies) {
            _res.headers.append("set-cookie", cookie);
          }
        } else {
          _res.headers.set(k, v);
        }
      }
    }
    this.#res = _res;
    this.finalized = true;
  }
  /**
   * `.render()` can create a response within a layout.
   *
   * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
   *
   * @example
   * ```ts
   * app.get('/', (c) => {
   *   return c.render('Hello!')
   * })
   * ```
   */
  render = /* @__PURE__ */ __name((...args) => {
    this.#renderer ??= (content) => this.html(content);
    return this.#renderer(...args);
  }, "render");
  /**
   * Sets the layout for the response.
   *
   * @param layout - The layout to set.
   * @returns The layout function.
   */
  setLayout = /* @__PURE__ */ __name((layout) => this.#layout = layout, "setLayout");
  /**
   * Gets the current layout for the response.
   *
   * @returns The current layout function.
   */
  getLayout = /* @__PURE__ */ __name(() => this.#layout, "getLayout");
  /**
   * `.setRenderer()` can set the layout in the custom middleware.
   *
   * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
   *
   * @example
   * ```tsx
   * app.use('*', async (c, next) => {
   *   c.setRenderer((content) => {
   *     return c.html(
   *       <html>
   *         <body>
   *           <p>{content}</p>
   *         </body>
   *       </html>
   *     )
   *   })
   *   await next()
   * })
   * ```
   */
  setRenderer = /* @__PURE__ */ __name((renderer) => {
    this.#renderer = renderer;
  }, "setRenderer");
  /**
   * `.header()` can set headers.
   *
   * @see {@link https://hono.dev/docs/api/context#header}
   *
   * @example
   * ```ts
   * app.get('/welcome', (c) => {
   *   // Set headers
   *   c.header('X-Message', 'Hello!')
   *   c.header('Content-Type', 'text/plain')
   *
   *   return c.body('Thank you for coming')
   * })
   * ```
   */
  header = /* @__PURE__ */ __name((name, value, options) => {
    if (this.finalized) {
      this.#res = createResponseInstance(this.#res.body, this.#res);
    }
    const headers = this.#res ? this.#res.headers : this.#preparedHeaders ??= new Headers();
    if (value === void 0) {
      headers.delete(name);
    } else if (options?.append) {
      headers.append(name, value);
    } else {
      headers.set(name, value);
    }
  }, "header");
  status = /* @__PURE__ */ __name((status) => {
    this.#status = status;
  }, "status");
  /**
   * `.set()` can set the value specified by the key.
   *
   * @see {@link https://hono.dev/docs/api/context#set-get}
   *
   * @example
   * ```ts
   * app.use('*', async (c, next) => {
   *   c.set('message', 'Hono is hot!!')
   *   await next()
   * })
   * ```
   */
  set = /* @__PURE__ */ __name((key, value) => {
    this.#var ??= /* @__PURE__ */ new Map();
    this.#var.set(key, value);
  }, "set");
  /**
   * `.get()` can use the value specified by the key.
   *
   * @see {@link https://hono.dev/docs/api/context#set-get}
   *
   * @example
   * ```ts
   * app.get('/', (c) => {
   *   const message = c.get('message')
   *   return c.text(`The message is "${message}"`)
   * })
   * ```
   */
  get = /* @__PURE__ */ __name((key) => {
    return this.#var ? this.#var.get(key) : void 0;
  }, "get");
  /**
   * `.var` can access the value of a variable.
   *
   * @see {@link https://hono.dev/docs/api/context#var}
   *
   * @example
   * ```ts
   * const result = c.var.client.oneMethod()
   * ```
   */
  // c.var.propName is a read-only
  get var() {
    if (!this.#var) {
      return {};
    }
    return Object.fromEntries(this.#var);
  }
  #newResponse(data, arg, headers) {
    const responseHeaders = this.#res ? new Headers(this.#res.headers) : this.#preparedHeaders ?? new Headers();
    if (typeof arg === "object" && "headers" in arg) {
      const argHeaders = arg.headers instanceof Headers ? arg.headers : new Headers(arg.headers);
      for (const [key, value] of argHeaders) {
        if (key.toLowerCase() === "set-cookie") {
          responseHeaders.append(key, value);
        } else {
          responseHeaders.set(key, value);
        }
      }
    }
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === "string") {
          responseHeaders.set(k, v);
        } else {
          responseHeaders.delete(k);
          for (const v2 of v) {
            responseHeaders.append(k, v2);
          }
        }
      }
    }
    const status = typeof arg === "number" ? arg : arg?.status ?? this.#status;
    return createResponseInstance(data, { status, headers: responseHeaders });
  }
  newResponse = /* @__PURE__ */ __name((...args) => this.#newResponse(...args), "newResponse");
  /**
   * `.body()` can return the HTTP response.
   * You can set headers with `.header()` and set HTTP status code with `.status`.
   * This can also be set in `.text()`, `.json()` and so on.
   *
   * @see {@link https://hono.dev/docs/api/context#body}
   *
   * @example
   * ```ts
   * app.get('/welcome', (c) => {
   *   // Set headers
   *   c.header('X-Message', 'Hello!')
   *   c.header('Content-Type', 'text/plain')
   *   // Set HTTP status code
   *   c.status(201)
   *
   *   // Return the response body
   *   return c.body('Thank you for coming')
   * })
   * ```
   */
  body = /* @__PURE__ */ __name((data, arg, headers) => this.#newResponse(data, arg, headers), "body");
  /**
   * `.text()` can render text as `Content-Type:text/plain`.
   *
   * @see {@link https://hono.dev/docs/api/context#text}
   *
   * @example
   * ```ts
   * app.get('/say', (c) => {
   *   return c.text('Hello!')
   * })
   * ```
   */
  text = /* @__PURE__ */ __name((text, arg, headers) => {
    return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized ? new Response(text) : this.#newResponse(
      text,
      arg,
      setDefaultContentType(TEXT_PLAIN, headers)
    );
  }, "text");
  /**
   * `.json()` can render JSON as `Content-Type:application/json`.
   *
   * @see {@link https://hono.dev/docs/api/context#json}
   *
   * @example
   * ```ts
   * app.get('/api', (c) => {
   *   return c.json({ message: 'Hello!' })
   * })
   * ```
   */
  json = /* @__PURE__ */ __name((object2, arg, headers) => {
    return this.#newResponse(
      JSON.stringify(object2),
      arg,
      setDefaultContentType("application/json", headers)
    );
  }, "json");
  html = /* @__PURE__ */ __name((html, arg, headers) => {
    const res = /* @__PURE__ */ __name((html2) => this.#newResponse(html2, arg, setDefaultContentType("text/html; charset=UTF-8", headers)), "res");
    return typeof html === "object" ? resolveCallback(html, HtmlEscapedCallbackPhase.Stringify, false, {}).then(res) : res(html);
  }, "html");
  /**
   * `.redirect()` can Redirect, default status code is 302.
   *
   * @see {@link https://hono.dev/docs/api/context#redirect}
   *
   * @example
   * ```ts
   * app.get('/redirect', (c) => {
   *   return c.redirect('/')
   * })
   * app.get('/redirect-permanently', (c) => {
   *   return c.redirect('/', 301)
   * })
   * ```
   */
  redirect = /* @__PURE__ */ __name((location, status) => {
    const locationString = String(location);
    this.header(
      "Location",
      // Multibyes should be encoded
      // eslint-disable-next-line no-control-regex
      !/[^\x00-\xFF]/.test(locationString) ? locationString : encodeURI(locationString)
    );
    return this.newResponse(null, status ?? 302);
  }, "redirect");
  /**
   * `.notFound()` can return the Not Found Response.
   *
   * @see {@link https://hono.dev/docs/api/context#notfound}
   *
   * @example
   * ```ts
   * app.get('/notfound', (c) => {
   *   return c.notFound()
   * })
   * ```
   */
  notFound = /* @__PURE__ */ __name(() => {
    this.#notFoundHandler ??= () => createResponseInstance();
    return this.#notFoundHandler(this);
  }, "notFound");
};

// node_modules/hono/dist/router.js
var METHOD_NAME_ALL = "ALL";
var METHOD_NAME_ALL_LOWERCASE = "all";
var METHODS = ["get", "post", "put", "delete", "options", "patch"];
var MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.";
var UnsupportedPathError = class extends Error {
  static {
    __name(this, "UnsupportedPathError");
  }
};

// node_modules/hono/dist/utils/constants.js
var COMPOSED_HANDLER = "__COMPOSED_HANDLER";

// node_modules/hono/dist/hono-base.js
var notFoundHandler = /* @__PURE__ */ __name((c) => {
  return c.text("404 Not Found", 404);
}, "notFoundHandler");
var errorHandler = /* @__PURE__ */ __name((err, c) => {
  if ("getResponse" in err) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
}, "errorHandler");
var Hono = class _Hono {
  static {
    __name(this, "_Hono");
  }
  get;
  post;
  put;
  delete;
  options;
  patch;
  all;
  on;
  use;
  /*
    This class is like an abstract class and does not have a router.
    To use it, inherit the class and implement router in the constructor.
  */
  router;
  getPath;
  // Cannot use `#` because it requires visibility at JavaScript runtime.
  _basePath = "/";
  #path = "/";
  routes = [];
  constructor(options = {}) {
    const allMethods = [...METHODS, METHOD_NAME_ALL_LOWERCASE];
    allMethods.forEach((method) => {
      this[method] = (args1, ...args) => {
        if (typeof args1 === "string") {
          this.#path = args1;
        } else {
          this.#addRoute(method, this.#path, args1);
        }
        args.forEach((handler) => {
          this.#addRoute(method, this.#path, handler);
        });
        return this;
      };
    });
    this.on = (method, path, ...handlers) => {
      for (const p of [path].flat()) {
        this.#path = p;
        for (const m of [method].flat()) {
          handlers.map((handler) => {
            this.#addRoute(m.toUpperCase(), this.#path, handler);
          });
        }
      }
      return this;
    };
    this.use = (arg1, ...handlers) => {
      if (typeof arg1 === "string") {
        this.#path = arg1;
      } else {
        this.#path = "*";
        handlers.unshift(arg1);
      }
      handlers.forEach((handler) => {
        this.#addRoute(METHOD_NAME_ALL, this.#path, handler);
      });
      return this;
    };
    const { strict, ...optionsWithoutStrict } = options;
    Object.assign(this, optionsWithoutStrict);
    this.getPath = strict ?? true ? options.getPath ?? getPath : getPathNoStrict;
  }
  #clone() {
    const clone = new _Hono({
      router: this.router,
      getPath: this.getPath
    });
    clone.errorHandler = this.errorHandler;
    clone.#notFoundHandler = this.#notFoundHandler;
    clone.routes = this.routes;
    return clone;
  }
  #notFoundHandler = notFoundHandler;
  // Cannot use `#` because it requires visibility at JavaScript runtime.
  errorHandler = errorHandler;
  /**
   * `.route()` allows grouping other Hono instance in routes.
   *
   * @see {@link https://hono.dev/docs/api/routing#grouping}
   *
   * @param {string} path - base Path
   * @param {Hono} app - other Hono instance
   * @returns {Hono} routed Hono instance
   *
   * @example
   * ```ts
   * const app = new Hono()
   * const app2 = new Hono()
   *
   * app2.get("/user", (c) => c.text("user"))
   * app.route("/api", app2) // GET /api/user
   * ```
   */
  route(path, app2) {
    const subApp = this.basePath(path);
    app2.routes.map((r) => {
      let handler;
      if (app2.errorHandler === errorHandler) {
        handler = r.handler;
      } else {
        handler = /* @__PURE__ */ __name(async (c, next) => (await compose([], app2.errorHandler)(c, () => r.handler(c, next))).res, "handler");
        handler[COMPOSED_HANDLER] = r.handler;
      }
      subApp.#addRoute(r.method, r.path, handler, r.basePath);
    });
    return this;
  }
  /**
   * `.basePath()` allows base paths to be specified.
   *
   * @see {@link https://hono.dev/docs/api/routing#base-path}
   *
   * @param {string} path - base Path
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * const api = new Hono().basePath('/api')
   * ```
   */
  basePath(path) {
    const subApp = this.#clone();
    subApp._basePath = mergePath(this._basePath, path);
    return subApp;
  }
  /**
   * `.onError()` handles an error and returns a customized Response.
   *
   * @see {@link https://hono.dev/docs/api/hono#error-handling}
   *
   * @param {ErrorHandler} handler - request Handler for error
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * app.onError((err, c) => {
   *   console.error(`${err}`)
   *   return c.text('Custom Error Message', 500)
   * })
   * ```
   */
  onError = /* @__PURE__ */ __name((handler) => {
    this.errorHandler = handler;
    return this;
  }, "onError");
  /**
   * `.notFound()` allows you to customize a Not Found Response.
   *
   * @see {@link https://hono.dev/docs/api/hono#not-found}
   *
   * @param {NotFoundHandler} handler - request handler for not-found
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * app.notFound((c) => {
   *   return c.text('Custom 404 Message', 404)
   * })
   * ```
   */
  notFound = /* @__PURE__ */ __name((handler) => {
    this.#notFoundHandler = handler;
    return this;
  }, "notFound");
  /**
   * `.mount()` allows you to mount applications built with other frameworks into your Hono application.
   *
   * @see {@link https://hono.dev/docs/api/hono#mount}
   *
   * @param {string} path - base Path
   * @param {Function} applicationHandler - other Request Handler
   * @param {MountOptions} [options] - options of `.mount()`
   * @returns {Hono} mounted Hono instance
   *
   * @example
   * ```ts
   * import { Router as IttyRouter } from 'itty-router'
   * import { Hono } from 'hono'
   * // Create itty-router application
   * const ittyRouter = IttyRouter()
   * // GET /itty-router/hello
   * ittyRouter.get('/hello', () => new Response('Hello from itty-router'))
   *
   * const app = new Hono()
   * app.mount('/itty-router', ittyRouter.handle)
   * ```
   *
   * @example
   * ```ts
   * const app = new Hono()
   * // Send the request to another application without modification.
   * app.mount('/app', anotherApp, {
   *   replaceRequest: (req) => req,
   * })
   * ```
   */
  mount(path, applicationHandler, options) {
    let replaceRequest;
    let optionHandler;
    if (options) {
      if (typeof options === "function") {
        optionHandler = options;
      } else {
        optionHandler = options.optionHandler;
        if (options.replaceRequest === false) {
          replaceRequest = /* @__PURE__ */ __name((request) => request, "replaceRequest");
        } else {
          replaceRequest = options.replaceRequest;
        }
      }
    }
    const getOptions = optionHandler ? (c) => {
      const options2 = optionHandler(c);
      return Array.isArray(options2) ? options2 : [options2];
    } : (c) => {
      let executionContext = void 0;
      try {
        executionContext = c.executionCtx;
      } catch {
      }
      return [c.env, executionContext];
    };
    replaceRequest ||= (() => {
      const mergedPath = mergePath(this._basePath, path);
      const pathPrefixLength = mergedPath === "/" ? 0 : mergedPath.length;
      return (request) => {
        const url = new URL(request.url);
        url.pathname = this.getPath(request).slice(pathPrefixLength) || "/";
        return new Request(url, request);
      };
    })();
    const handler = /* @__PURE__ */ __name(async (c, next) => {
      const res = await applicationHandler(replaceRequest(c.req.raw), ...getOptions(c));
      if (res) {
        return res;
      }
      await next();
    }, "handler");
    this.#addRoute(METHOD_NAME_ALL, mergePath(path, "*"), handler);
    return this;
  }
  #addRoute(method, path, handler, baseRoutePath) {
    method = method.toUpperCase();
    path = mergePath(this._basePath, path);
    const r = {
      basePath: baseRoutePath !== void 0 ? mergePath(this._basePath, baseRoutePath) : this._basePath,
      path,
      method,
      handler
    };
    this.router.add(method, path, [handler, r]);
    this.routes.push(r);
  }
  #handleError(err, c) {
    if (err instanceof Error) {
      return this.errorHandler(err, c);
    }
    throw err;
  }
  #dispatch(request, executionCtx, env, method) {
    if (method === "HEAD") {
      return (async () => new Response(null, await this.#dispatch(request, executionCtx, env, "GET")))();
    }
    const path = this.getPath(request, { env });
    const matchResult = this.router.match(method, path);
    const c = new Context(request, {
      path,
      matchResult,
      env,
      executionCtx,
      notFoundHandler: this.#notFoundHandler
    });
    if (matchResult[0].length === 1) {
      let res;
      try {
        res = matchResult[0][0][0][0](c, async () => {
          c.res = await this.#notFoundHandler(c);
        });
      } catch (err) {
        return this.#handleError(err, c);
      }
      return res instanceof Promise ? res.then(
        (resolved) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c))
      ).catch((err) => this.#handleError(err, c)) : res ?? this.#notFoundHandler(c);
    }
    const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler);
    return (async () => {
      try {
        const context = await composed(c);
        if (!context.finalized) {
          throw new Error(
            "Context is not finalized. Did you forget to return a Response object or `await next()`?"
          );
        }
        return context.res;
      } catch (err) {
        return this.#handleError(err, c);
      }
    })();
  }
  /**
   * `.fetch()` will be entry point of your app.
   *
   * @see {@link https://hono.dev/docs/api/hono#fetch}
   *
   * @param {Request} request - request Object of request
   * @param {Env} Env - env Object
   * @param {ExecutionContext} - context of execution
   * @returns {Response | Promise<Response>} response of request
   *
   */
  fetch = /* @__PURE__ */ __name((request, ...rest) => {
    return this.#dispatch(request, rest[1], rest[0], request.method);
  }, "fetch");
  /**
   * `.request()` is a useful method for testing.
   * You can pass a URL or pathname to send a GET request.
   * app will return a Response object.
   * ```ts
   * test('GET /hello is ok', async () => {
   *   const res = await app.request('/hello')
   *   expect(res.status).toBe(200)
   * })
   * ```
   * @see https://hono.dev/docs/api/hono#request
   */
  request = /* @__PURE__ */ __name((input, requestInit, Env, executionCtx) => {
    if (input instanceof Request) {
      return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
    }
    input = input.toString();
    return this.fetch(
      new Request(
        /^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`,
        requestInit
      ),
      Env,
      executionCtx
    );
  }, "request");
  /**
   * `.fire()` automatically adds a global fetch event listener.
   * This can be useful for environments that adhere to the Service Worker API, such as non-ES module Cloudflare Workers.
   * @deprecated
   * Use `fire` from `hono/service-worker` instead.
   * ```ts
   * import { Hono } from 'hono'
   * import { fire } from 'hono/service-worker'
   *
   * const app = new Hono()
   * // ...
   * fire(app)
   * ```
   * @see https://hono.dev/docs/api/hono#fire
   * @see https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
   * @see https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/
   */
  fire = /* @__PURE__ */ __name(() => {
    addEventListener("fetch", (event) => {
      event.respondWith(this.#dispatch(event.request, event, void 0, event.request.method));
    });
  }, "fire");
};

// node_modules/hono/dist/router/reg-exp-router/matcher.js
var emptyParam = [];
function match(method, path) {
  const matchers = this.buildAllMatchers();
  const match2 = /* @__PURE__ */ __name(((method2, path2) => {
    const matcher = matchers[method2] || matchers[METHOD_NAME_ALL];
    const staticMatch = matcher[2][path2];
    if (staticMatch) {
      return staticMatch;
    }
    const match3 = path2.match(matcher[0]);
    if (!match3) {
      return [[], emptyParam];
    }
    const index = match3.indexOf("", 1);
    return [matcher[1][index], match3];
  }), "match2");
  this.match = match2;
  return match2(method, path);
}
__name(match, "match");

// node_modules/hono/dist/router/reg-exp-router/node.js
var LABEL_REG_EXP_STR = "[^/]+";
var ONLY_WILDCARD_REG_EXP_STR = ".*";
var TAIL_WILDCARD_REG_EXP_STR = "(?:|/.*)";
var PATH_ERROR = /* @__PURE__ */ Symbol();
var regExpMetaChars = new Set(".\\+*[^]$()");
function compareKey(a, b) {
  if (a.length === 1) {
    return b.length === 1 ? a < b ? -1 : 1 : -1;
  }
  if (b.length === 1) {
    return 1;
  }
  if (a === ONLY_WILDCARD_REG_EXP_STR || a === TAIL_WILDCARD_REG_EXP_STR) {
    return 1;
  } else if (b === ONLY_WILDCARD_REG_EXP_STR || b === TAIL_WILDCARD_REG_EXP_STR) {
    return -1;
  }
  if (a === LABEL_REG_EXP_STR) {
    return 1;
  } else if (b === LABEL_REG_EXP_STR) {
    return -1;
  }
  return a.length === b.length ? a < b ? -1 : 1 : b.length - a.length;
}
__name(compareKey, "compareKey");
var Node = class _Node {
  static {
    __name(this, "_Node");
  }
  #index;
  #varIndex;
  #children = /* @__PURE__ */ Object.create(null);
  insert(tokens, index, paramMap, context, pathErrorCheckOnly) {
    if (tokens.length === 0) {
      if (this.#index !== void 0) {
        throw PATH_ERROR;
      }
      if (pathErrorCheckOnly) {
        return;
      }
      this.#index = index;
      return;
    }
    const [token, ...restTokens] = tokens;
    const pattern = token === "*" ? restTokens.length === 0 ? ["", "", ONLY_WILDCARD_REG_EXP_STR] : ["", "", LABEL_REG_EXP_STR] : token === "/*" ? ["", "", TAIL_WILDCARD_REG_EXP_STR] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
    let node;
    if (pattern) {
      const name = pattern[1];
      let regexpStr = pattern[2] || LABEL_REG_EXP_STR;
      if (name && pattern[2]) {
        if (regexpStr === ".*") {
          throw PATH_ERROR;
        }
        regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
        if (/\((?!\?:)/.test(regexpStr)) {
          throw PATH_ERROR;
        }
      }
      node = this.#children[regexpStr];
      if (!node) {
        if (Object.keys(this.#children).some(
          (k) => k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR
        )) {
          throw PATH_ERROR;
        }
        if (pathErrorCheckOnly) {
          return;
        }
        node = this.#children[regexpStr] = new _Node();
        if (name !== "") {
          node.#varIndex = context.varIndex++;
        }
      }
      if (!pathErrorCheckOnly && name !== "") {
        paramMap.push([name, node.#varIndex]);
      }
    } else {
      node = this.#children[token];
      if (!node) {
        if (Object.keys(this.#children).some(
          (k) => k.length > 1 && k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR
        )) {
          throw PATH_ERROR;
        }
        if (pathErrorCheckOnly) {
          return;
        }
        node = this.#children[token] = new _Node();
      }
    }
    node.insert(restTokens, index, paramMap, context, pathErrorCheckOnly);
  }
  buildRegExpStr() {
    const childKeys = Object.keys(this.#children).sort(compareKey);
    const strList = childKeys.map((k) => {
      const c = this.#children[k];
      return (typeof c.#varIndex === "number" ? `(${k})@${c.#varIndex}` : regExpMetaChars.has(k) ? `\\${k}` : k) + c.buildRegExpStr();
    });
    if (typeof this.#index === "number") {
      strList.unshift(`#${this.#index}`);
    }
    if (strList.length === 0) {
      return "";
    }
    if (strList.length === 1) {
      return strList[0];
    }
    return "(?:" + strList.join("|") + ")";
  }
};

// node_modules/hono/dist/router/reg-exp-router/trie.js
var Trie = class {
  static {
    __name(this, "Trie");
  }
  #context = { varIndex: 0 };
  #root = new Node();
  insert(path, index, pathErrorCheckOnly) {
    const paramAssoc = [];
    const groups = [];
    for (let i = 0; ; ) {
      let replaced = false;
      path = path.replace(/\{[^}]+\}/g, (m) => {
        const mark = `@\\${i}`;
        groups[i] = [mark, m];
        i++;
        replaced = true;
        return mark;
      });
      if (!replaced) {
        break;
      }
    }
    const tokens = path.match(/(?::[^\/]+)|(?:\/\*$)|./g) || [];
    for (let i = groups.length - 1; i >= 0; i--) {
      const [mark] = groups[i];
      for (let j = tokens.length - 1; j >= 0; j--) {
        if (tokens[j].indexOf(mark) !== -1) {
          tokens[j] = tokens[j].replace(mark, groups[i][1]);
          break;
        }
      }
    }
    this.#root.insert(tokens, index, paramAssoc, this.#context, pathErrorCheckOnly);
    return paramAssoc;
  }
  buildRegExp() {
    let regexp = this.#root.buildRegExpStr();
    if (regexp === "") {
      return [/^$/, [], []];
    }
    let captureIndex = 0;
    const indexReplacementMap = [];
    const paramReplacementMap = [];
    regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
      if (handlerIndex !== void 0) {
        indexReplacementMap[++captureIndex] = Number(handlerIndex);
        return "$()";
      }
      if (paramIndex !== void 0) {
        paramReplacementMap[Number(paramIndex)] = ++captureIndex;
        return "";
      }
      return "";
    });
    return [new RegExp(`^${regexp}`), indexReplacementMap, paramReplacementMap];
  }
};

// node_modules/hono/dist/router/reg-exp-router/router.js
var nullMatcher = [/^$/, [], /* @__PURE__ */ Object.create(null)];
var wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
function buildWildcardRegExp(path) {
  return wildcardRegExpCache[path] ??= new RegExp(
    path === "*" ? "" : `^${path.replace(
      /\/\*$|([.\\+*[^\]$()])/g,
      (_, metaChar) => metaChar ? `\\${metaChar}` : "(?:|/.*)"
    )}$`
  );
}
__name(buildWildcardRegExp, "buildWildcardRegExp");
function clearWildcardRegExpCache() {
  wildcardRegExpCache = /* @__PURE__ */ Object.create(null);
}
__name(clearWildcardRegExpCache, "clearWildcardRegExpCache");
function buildMatcherFromPreprocessedRoutes(routes) {
  const trie = new Trie();
  const handlerData = [];
  if (routes.length === 0) {
    return nullMatcher;
  }
  const routesWithStaticPathFlag = routes.map(
    (route) => [!/\*|\/:/.test(route[0]), ...route]
  ).sort(
    ([isStaticA, pathA], [isStaticB, pathB]) => isStaticA ? 1 : isStaticB ? -1 : pathA.length - pathB.length
  );
  const staticMap = /* @__PURE__ */ Object.create(null);
  for (let i = 0, j = -1, len = routesWithStaticPathFlag.length; i < len; i++) {
    const [pathErrorCheckOnly, path, handlers] = routesWithStaticPathFlag[i];
    if (pathErrorCheckOnly) {
      staticMap[path] = [handlers.map(([h]) => [h, /* @__PURE__ */ Object.create(null)]), emptyParam];
    } else {
      j++;
    }
    let paramAssoc;
    try {
      paramAssoc = trie.insert(path, j, pathErrorCheckOnly);
    } catch (e) {
      throw e === PATH_ERROR ? new UnsupportedPathError(path) : e;
    }
    if (pathErrorCheckOnly) {
      continue;
    }
    handlerData[j] = handlers.map(([h, paramCount]) => {
      const paramIndexMap = /* @__PURE__ */ Object.create(null);
      paramCount -= 1;
      for (; paramCount >= 0; paramCount--) {
        const [key, value] = paramAssoc[paramCount];
        paramIndexMap[key] = value;
      }
      return [h, paramIndexMap];
    });
  }
  const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp();
  for (let i = 0, len = handlerData.length; i < len; i++) {
    for (let j = 0, len2 = handlerData[i].length; j < len2; j++) {
      const map = handlerData[i][j]?.[1];
      if (!map) {
        continue;
      }
      const keys = Object.keys(map);
      for (let k = 0, len3 = keys.length; k < len3; k++) {
        map[keys[k]] = paramReplacementMap[map[keys[k]]];
      }
    }
  }
  const handlerMap = [];
  for (const i in indexReplacementMap) {
    handlerMap[i] = handlerData[indexReplacementMap[i]];
  }
  return [regexp, handlerMap, staticMap];
}
__name(buildMatcherFromPreprocessedRoutes, "buildMatcherFromPreprocessedRoutes");
function findMiddleware(middleware, path) {
  if (!middleware) {
    return void 0;
  }
  for (const k of Object.keys(middleware).sort((a, b) => b.length - a.length)) {
    if (buildWildcardRegExp(k).test(path)) {
      return [...middleware[k]];
    }
  }
  return void 0;
}
__name(findMiddleware, "findMiddleware");
var RegExpRouter = class {
  static {
    __name(this, "RegExpRouter");
  }
  name = "RegExpRouter";
  #middleware;
  #routes;
  constructor() {
    this.#middleware = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
    this.#routes = { [METHOD_NAME_ALL]: /* @__PURE__ */ Object.create(null) };
  }
  add(method, path, handler) {
    const middleware = this.#middleware;
    const routes = this.#routes;
    if (!middleware || !routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    if (!middleware[method]) {
      ;
      [middleware, routes].forEach((handlerMap) => {
        handlerMap[method] = /* @__PURE__ */ Object.create(null);
        Object.keys(handlerMap[METHOD_NAME_ALL]).forEach((p) => {
          handlerMap[method][p] = [...handlerMap[METHOD_NAME_ALL][p]];
        });
      });
    }
    if (path === "/*") {
      path = "*";
    }
    const paramCount = (path.match(/\/:/g) || []).length;
    if (/\*$/.test(path)) {
      const re = buildWildcardRegExp(path);
      if (method === METHOD_NAME_ALL) {
        Object.keys(middleware).forEach((m) => {
          middleware[m][path] ||= findMiddleware(middleware[m], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
        });
      } else {
        middleware[method][path] ||= findMiddleware(middleware[method], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
      }
      Object.keys(middleware).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(middleware[m]).forEach((p) => {
            re.test(p) && middleware[m][p].push([handler, paramCount]);
          });
        }
      });
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          Object.keys(routes[m]).forEach(
            (p) => re.test(p) && routes[m][p].push([handler, paramCount])
          );
        }
      });
      return;
    }
    const paths = checkOptionalParameter(path) || [path];
    for (let i = 0, len = paths.length; i < len; i++) {
      const path2 = paths[i];
      Object.keys(routes).forEach((m) => {
        if (method === METHOD_NAME_ALL || method === m) {
          routes[m][path2] ||= [
            ...findMiddleware(middleware[m], path2) || findMiddleware(middleware[METHOD_NAME_ALL], path2) || []
          ];
          routes[m][path2].push([handler, paramCount - len + i + 1]);
        }
      });
    }
  }
  match = match;
  buildAllMatchers() {
    const matchers = /* @__PURE__ */ Object.create(null);
    Object.keys(this.#routes).concat(Object.keys(this.#middleware)).forEach((method) => {
      matchers[method] ||= this.#buildMatcher(method);
    });
    this.#middleware = this.#routes = void 0;
    clearWildcardRegExpCache();
    return matchers;
  }
  #buildMatcher(method) {
    const routes = [];
    let hasOwnRoute = method === METHOD_NAME_ALL;
    [this.#middleware, this.#routes].forEach((r) => {
      const ownRoute = r[method] ? Object.keys(r[method]).map((path) => [path, r[method][path]]) : [];
      if (ownRoute.length !== 0) {
        hasOwnRoute ||= true;
        routes.push(...ownRoute);
      } else if (method !== METHOD_NAME_ALL) {
        routes.push(
          ...Object.keys(r[METHOD_NAME_ALL]).map((path) => [path, r[METHOD_NAME_ALL][path]])
        );
      }
    });
    if (!hasOwnRoute) {
      return null;
    } else {
      return buildMatcherFromPreprocessedRoutes(routes);
    }
  }
};

// node_modules/hono/dist/router/smart-router/router.js
var SmartRouter = class {
  static {
    __name(this, "SmartRouter");
  }
  name = "SmartRouter";
  #routers = [];
  #routes = [];
  constructor(init) {
    this.#routers = init.routers;
  }
  add(method, path, handler) {
    if (!this.#routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    this.#routes.push([method, path, handler]);
  }
  match(method, path) {
    if (!this.#routes) {
      throw new Error("Fatal error");
    }
    const routers = this.#routers;
    const routes = this.#routes;
    const len = routers.length;
    let i = 0;
    let res;
    for (; i < len; i++) {
      const router = routers[i];
      try {
        for (let i2 = 0, len2 = routes.length; i2 < len2; i2++) {
          router.add(...routes[i2]);
        }
        res = router.match(method, path);
      } catch (e) {
        if (e instanceof UnsupportedPathError) {
          continue;
        }
        throw e;
      }
      this.match = router.match.bind(router);
      this.#routers = [router];
      this.#routes = void 0;
      break;
    }
    if (i === len) {
      throw new Error("Fatal error");
    }
    this.name = `SmartRouter + ${this.activeRouter.name}`;
    return res;
  }
  get activeRouter() {
    if (this.#routes || this.#routers.length !== 1) {
      throw new Error("No active router has been determined yet.");
    }
    return this.#routers[0];
  }
};

// node_modules/hono/dist/router/trie-router/node.js
var emptyParams = /* @__PURE__ */ Object.create(null);
var hasChildren = /* @__PURE__ */ __name((children) => {
  for (const _ in children) {
    return true;
  }
  return false;
}, "hasChildren");
var Node2 = class _Node2 {
  static {
    __name(this, "_Node");
  }
  #methods;
  #children;
  #patterns;
  #order = 0;
  #params = emptyParams;
  constructor(method, handler, children) {
    this.#children = children || /* @__PURE__ */ Object.create(null);
    this.#methods = [];
    if (method && handler) {
      const m = /* @__PURE__ */ Object.create(null);
      m[method] = { handler, possibleKeys: [], score: 0 };
      this.#methods = [m];
    }
    this.#patterns = [];
  }
  insert(method, path, handler) {
    this.#order = ++this.#order;
    let curNode = this;
    const parts = splitRoutingPath(path);
    const possibleKeys = [];
    for (let i = 0, len = parts.length; i < len; i++) {
      const p = parts[i];
      const nextP = parts[i + 1];
      const pattern = getPattern(p, nextP);
      const key = Array.isArray(pattern) ? pattern[0] : p;
      if (key in curNode.#children) {
        curNode = curNode.#children[key];
        if (pattern) {
          possibleKeys.push(pattern[1]);
        }
        continue;
      }
      curNode.#children[key] = new _Node2();
      if (pattern) {
        curNode.#patterns.push(pattern);
        possibleKeys.push(pattern[1]);
      }
      curNode = curNode.#children[key];
    }
    curNode.#methods.push({
      [method]: {
        handler,
        possibleKeys: possibleKeys.filter((v, i, a) => a.indexOf(v) === i),
        score: this.#order
      }
    });
    return curNode;
  }
  #pushHandlerSets(handlerSets, node, method, nodeParams, params) {
    for (let i = 0, len = node.#methods.length; i < len; i++) {
      const m = node.#methods[i];
      const handlerSet = m[method] || m[METHOD_NAME_ALL];
      const processedSet = {};
      if (handlerSet !== void 0) {
        handlerSet.params = /* @__PURE__ */ Object.create(null);
        handlerSets.push(handlerSet);
        if (nodeParams !== emptyParams || params && params !== emptyParams) {
          for (let i2 = 0, len2 = handlerSet.possibleKeys.length; i2 < len2; i2++) {
            const key = handlerSet.possibleKeys[i2];
            const processed = processedSet[handlerSet.score];
            handlerSet.params[key] = params?.[key] && !processed ? params[key] : nodeParams[key] ?? params?.[key];
            processedSet[handlerSet.score] = true;
          }
        }
      }
    }
  }
  search(method, path) {
    const handlerSets = [];
    this.#params = emptyParams;
    const curNode = this;
    let curNodes = [curNode];
    const parts = splitPath(path);
    const curNodesQueue = [];
    const len = parts.length;
    let partOffsets = null;
    for (let i = 0; i < len; i++) {
      const part = parts[i];
      const isLast = i === len - 1;
      const tempNodes = [];
      for (let j = 0, len2 = curNodes.length; j < len2; j++) {
        const node = curNodes[j];
        const nextNode = node.#children[part];
        if (nextNode) {
          nextNode.#params = node.#params;
          if (isLast) {
            if (nextNode.#children["*"]) {
              this.#pushHandlerSets(handlerSets, nextNode.#children["*"], method, node.#params);
            }
            this.#pushHandlerSets(handlerSets, nextNode, method, node.#params);
          } else {
            tempNodes.push(nextNode);
          }
        }
        for (let k = 0, len3 = node.#patterns.length; k < len3; k++) {
          const pattern = node.#patterns[k];
          const params = node.#params === emptyParams ? {} : { ...node.#params };
          if (pattern === "*") {
            const astNode = node.#children["*"];
            if (astNode) {
              this.#pushHandlerSets(handlerSets, astNode, method, node.#params);
              astNode.#params = params;
              tempNodes.push(astNode);
            }
            continue;
          }
          const [key, name, matcher] = pattern;
          if (!part && !(matcher instanceof RegExp)) {
            continue;
          }
          const child = node.#children[key];
          if (matcher instanceof RegExp) {
            if (partOffsets === null) {
              partOffsets = new Array(len);
              let offset = path[0] === "/" ? 1 : 0;
              for (let p = 0; p < len; p++) {
                partOffsets[p] = offset;
                offset += parts[p].length + 1;
              }
            }
            const restPathString = path.substring(partOffsets[i]);
            const m = matcher.exec(restPathString);
            if (m) {
              params[name] = m[0];
              this.#pushHandlerSets(handlerSets, child, method, node.#params, params);
              if (hasChildren(child.#children)) {
                child.#params = params;
                const componentCount = m[0].match(/\//)?.length ?? 0;
                const targetCurNodes = curNodesQueue[componentCount] ||= [];
                targetCurNodes.push(child);
              }
              continue;
            }
          }
          if (matcher === true || matcher.test(part)) {
            params[name] = part;
            if (isLast) {
              this.#pushHandlerSets(handlerSets, child, method, params, node.#params);
              if (child.#children["*"]) {
                this.#pushHandlerSets(
                  handlerSets,
                  child.#children["*"],
                  method,
                  params,
                  node.#params
                );
              }
            } else {
              child.#params = params;
              tempNodes.push(child);
            }
          }
        }
      }
      const shifted = curNodesQueue.shift();
      curNodes = shifted ? tempNodes.concat(shifted) : tempNodes;
    }
    if (handlerSets.length > 1) {
      handlerSets.sort((a, b) => {
        return a.score - b.score;
      });
    }
    return [handlerSets.map(({ handler, params }) => [handler, params])];
  }
};

// node_modules/hono/dist/router/trie-router/router.js
var TrieRouter = class {
  static {
    __name(this, "TrieRouter");
  }
  name = "TrieRouter";
  #node;
  constructor() {
    this.#node = new Node2();
  }
  add(method, path, handler) {
    const results = checkOptionalParameter(path);
    if (results) {
      for (let i = 0, len = results.length; i < len; i++) {
        this.#node.insert(method, results[i], handler);
      }
      return;
    }
    this.#node.insert(method, path, handler);
  }
  match(method, path) {
    return this.#node.search(method, path);
  }
};

// node_modules/hono/dist/hono.js
var Hono2 = class extends Hono {
  static {
    __name(this, "Hono");
  }
  /**
   * Creates an instance of the Hono class.
   *
   * @param options - Optional configuration options for the Hono instance.
   */
  constructor(options = {}) {
    super(options);
    this.router = options.router ?? new SmartRouter({
      routers: [new RegExpRouter(), new TrieRouter()]
    });
  }
};

// node_modules/@libsql/core/lib-esm/api.js
var LibsqlError = class extends Error {
  static {
    __name(this, "LibsqlError");
  }
  /** Machine-readable error code. */
  code;
  /** Extended error code with more specific information (e.g., SQLITE_CONSTRAINT_PRIMARYKEY). */
  extendedCode;
  /** Raw numeric error code */
  rawCode;
  constructor(message, code, extendedCode, rawCode, cause) {
    if (code !== void 0) {
      message = `${code}: ${message}`;
    }
    super(message, { cause });
    this.code = code;
    this.extendedCode = extendedCode;
    this.rawCode = rawCode;
    this.name = "LibsqlError";
  }
};
var LibsqlBatchError = class extends LibsqlError {
  static {
    __name(this, "LibsqlBatchError");
  }
  /** The zero-based index of the statement that failed in the batch. */
  statementIndex;
  constructor(message, statementIndex, code, extendedCode, rawCode, cause) {
    super(message, code, extendedCode, rawCode, cause);
    this.statementIndex = statementIndex;
    this.name = "LibsqlBatchError";
  }
};

// node_modules/@libsql/core/lib-esm/uri.js
function parseUri(text) {
  const match2 = URI_RE.exec(text);
  if (match2 === null) {
    throw new LibsqlError(`The URL '${text}' is not in a valid format`, "URL_INVALID");
  }
  const groups = match2.groups;
  const scheme = groups["scheme"];
  const authority = groups["authority"] !== void 0 ? parseAuthority(groups["authority"]) : void 0;
  const path = percentDecode(groups["path"]);
  const query = groups["query"] !== void 0 ? parseQuery(groups["query"]) : void 0;
  const fragment = groups["fragment"] !== void 0 ? percentDecode(groups["fragment"]) : void 0;
  return { scheme, authority, path, query, fragment };
}
__name(parseUri, "parseUri");
var URI_RE = (() => {
  const SCHEME = "(?<scheme>[A-Za-z][A-Za-z.+-]*)";
  const AUTHORITY = "(?<authority>[^/?#]*)";
  const PATH = "(?<path>[^?#]*)";
  const QUERY = "(?<query>[^#]*)";
  const FRAGMENT = "(?<fragment>.*)";
  return new RegExp(`^${SCHEME}:(//${AUTHORITY})?${PATH}(\\?${QUERY})?(#${FRAGMENT})?$`, "su");
})();
function parseAuthority(text) {
  const match2 = AUTHORITY_RE.exec(text);
  if (match2 === null) {
    throw new LibsqlError("The authority part of the URL is not in a valid format", "URL_INVALID");
  }
  const groups = match2.groups;
  const host = percentDecode(groups["host_br"] ?? groups["host"]);
  const port = groups["port"] ? parseInt(groups["port"], 10) : void 0;
  const userinfo = groups["username"] !== void 0 ? {
    username: percentDecode(groups["username"]),
    password: groups["password"] !== void 0 ? percentDecode(groups["password"]) : void 0
  } : void 0;
  return { host, port, userinfo };
}
__name(parseAuthority, "parseAuthority");
var AUTHORITY_RE = (() => {
  return new RegExp(`^((?<username>[^:]*)(:(?<password>.*))?@)?((?<host>[^:\\[\\]]*)|(\\[(?<host_br>[^\\[\\]]*)\\]))(:(?<port>[0-9]*))?$`, "su");
})();
function parseQuery(text) {
  const sequences = text.split("&");
  const pairs = [];
  for (const sequence of sequences) {
    if (sequence === "") {
      continue;
    }
    let key;
    let value;
    const splitIdx = sequence.indexOf("=");
    if (splitIdx < 0) {
      key = sequence;
      value = "";
    } else {
      key = sequence.substring(0, splitIdx);
      value = sequence.substring(splitIdx + 1);
    }
    pairs.push({
      key: percentDecode(key.replaceAll("+", " ")),
      value: percentDecode(value.replaceAll("+", " "))
    });
  }
  return { pairs };
}
__name(parseQuery, "parseQuery");
function percentDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch (e) {
    if (e instanceof URIError) {
      throw new LibsqlError(`URL component has invalid percent encoding: ${e}`, "URL_INVALID", void 0, void 0, e);
    }
    throw e;
  }
}
__name(percentDecode, "percentDecode");
function encodeBaseUrl(scheme, authority, path) {
  if (authority === void 0) {
    throw new LibsqlError(`URL with scheme ${JSON.stringify(scheme + ":")} requires authority (the "//" part)`, "URL_INVALID");
  }
  const schemeText = `${scheme}:`;
  const hostText = encodeHost(authority.host);
  const portText = encodePort(authority.port);
  const userinfoText = encodeUserinfo(authority.userinfo);
  const authorityText = `//${userinfoText}${hostText}${portText}`;
  let pathText = path.split("/").map(encodeURIComponent).join("/");
  if (pathText !== "" && !pathText.startsWith("/")) {
    pathText = "/" + pathText;
  }
  return new URL(`${schemeText}${authorityText}${pathText}`);
}
__name(encodeBaseUrl, "encodeBaseUrl");
function encodeHost(host) {
  return host.includes(":") ? `[${encodeURI(host)}]` : encodeURI(host);
}
__name(encodeHost, "encodeHost");
function encodePort(port) {
  return port !== void 0 ? `:${port}` : "";
}
__name(encodePort, "encodePort");
function encodeUserinfo(userinfo) {
  if (userinfo === void 0) {
    return "";
  }
  const usernameText = encodeURIComponent(userinfo.username);
  const passwordText = userinfo.password !== void 0 ? `:${encodeURIComponent(userinfo.password)}` : "";
  return `${usernameText}${passwordText}@`;
}
__name(encodeUserinfo, "encodeUserinfo");

// node_modules/js-base64/base64.mjs
var version = "3.8.0";
var VERSION = version;
var _hasBuffer = typeof Buffer === "function";
var _TD = typeof TextDecoder === "function" ? new TextDecoder("utf-8", { ignoreBOM: true }) : void 0;
var _TE = typeof TextEncoder === "function" ? new TextEncoder() : void 0;
var b64ch = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
var b64chs = Array.prototype.slice.call(b64ch);
var b64tab = ((a) => {
  let tab = {};
  a.forEach((c, i) => tab[c] = i);
  return tab;
})(b64chs);
var b64re = /^(?:[A-Za-z\d+\/]{4})*?(?:[A-Za-z\d+\/]{2}(?:==)?|[A-Za-z\d+\/]{3}=?)?$/;
var _fromCC = String.fromCharCode.bind(String);
var _U8Afrom = typeof Uint8Array.from === "function" ? Uint8Array.from.bind(Uint8Array) : (it) => new Uint8Array(Array.prototype.slice.call(it, 0));
var _mkUriSafe = /* @__PURE__ */ __name((src) => src.replace(/=/g, "").replace(/[+\/]/g, (m0) => m0 == "+" ? "-" : "_"), "_mkUriSafe");
var _tidyB64 = /* @__PURE__ */ __name((s) => s.replace(/[^A-Za-z0-9\+\/]/g, ""), "_tidyB64");
var btoaPolyfill = /* @__PURE__ */ __name((bin) => {
  let u32, c0, c1, c2, asc = "";
  const pad = bin.length % 3;
  for (let i = 0; i < bin.length; ) {
    if ((c0 = bin.charCodeAt(i++)) > 255 || (c1 = bin.charCodeAt(i++)) > 255 || (c2 = bin.charCodeAt(i++)) > 255)
      throw new TypeError("invalid character found");
    u32 = c0 << 16 | c1 << 8 | c2;
    asc += b64chs[u32 >> 18 & 63] + b64chs[u32 >> 12 & 63] + b64chs[u32 >> 6 & 63] + b64chs[u32 & 63];
  }
  return pad ? asc.slice(0, pad - 3) + "===".substring(pad) : asc;
}, "btoaPolyfill");
var _btoa = typeof btoa === "function" ? (bin) => btoa(bin) : _hasBuffer ? (bin) => Buffer.from(bin, "binary").toString("base64") : btoaPolyfill;
var _fromUint8Array = _hasBuffer ? (u8a) => Buffer.from(u8a).toString("base64") : (u8a) => {
  const maxargs = 4096;
  let strs = [];
  for (let i = 0, l = u8a.length; i < l; i += maxargs) {
    strs.push(_fromCC.apply(null, u8a.subarray(i, i + maxargs)));
  }
  return _btoa(strs.join(""));
};
var fromUint8Array = /* @__PURE__ */ __name((u8a, urlsafe = false) => urlsafe ? _mkUriSafe(_fromUint8Array(u8a)) : _fromUint8Array(u8a), "fromUint8Array");
var cb_utob = /* @__PURE__ */ __name((c) => {
  if (c.length < 2) {
    var cc = c.charCodeAt(0);
    return cc < 128 ? c : cc < 2048 ? _fromCC(192 | cc >>> 6) + _fromCC(128 | cc & 63) : _fromCC(224 | cc >>> 12 & 15) + _fromCC(128 | cc >>> 6 & 63) + _fromCC(128 | cc & 63);
  } else {
    var cc = 65536 + (c.charCodeAt(0) - 55296) * 1024 + (c.charCodeAt(1) - 56320);
    return _fromCC(240 | cc >>> 18 & 7) + _fromCC(128 | cc >>> 12 & 63) + _fromCC(128 | cc >>> 6 & 63) + _fromCC(128 | cc & 63);
  }
}, "cb_utob");
var re_utob = /[\uD800-\uDBFF][\uDC00-\uDFFFF]|[^\x00-\x7F]/g;
var utob = /* @__PURE__ */ __name((u) => u.replace(re_utob, cb_utob), "utob");
var _encode = _hasBuffer ? (s) => Buffer.from(s, "utf8").toString("base64") : _TE ? (s) => _fromUint8Array(_TE.encode(s)) : (s) => _btoa(utob(s));
var encode = /* @__PURE__ */ __name((src, urlsafe = false) => urlsafe ? _mkUriSafe(_encode(src)) : _encode(src), "encode");
var encodeURI2 = /* @__PURE__ */ __name((src) => encode(src, true), "encodeURI");
var re_btou = /[\xC0-\xDF][\x80-\xBF]|[\xE0-\xEF][\x80-\xBF]{2}|[\xF0-\xF7][\x80-\xBF]{3}/g;
var cb_btou = /* @__PURE__ */ __name((cccc) => {
  switch (cccc.length) {
    case 4:
      var cp = (7 & cccc.charCodeAt(0)) << 18 | (63 & cccc.charCodeAt(1)) << 12 | (63 & cccc.charCodeAt(2)) << 6 | 63 & cccc.charCodeAt(3), offset = cp - 65536;
      return _fromCC((offset >>> 10) + 55296) + _fromCC((offset & 1023) + 56320);
    case 3:
      return _fromCC((15 & cccc.charCodeAt(0)) << 12 | (63 & cccc.charCodeAt(1)) << 6 | 63 & cccc.charCodeAt(2));
    default:
      return _fromCC((31 & cccc.charCodeAt(0)) << 6 | 63 & cccc.charCodeAt(1));
  }
}, "cb_btou");
var btou = /* @__PURE__ */ __name((b) => b.replace(re_btou, cb_btou), "btou");
var atobPolyfill = /* @__PURE__ */ __name((asc) => {
  asc = asc.replace(/\s+/g, "");
  if (!b64re.test(asc))
    throw new TypeError("malformed base64.");
  asc += "==".slice(2 - (asc.length & 3));
  let u24, r1, r2;
  let binArray = [];
  for (let i = 0; i < asc.length; ) {
    u24 = b64tab[asc.charAt(i++)] << 18 | b64tab[asc.charAt(i++)] << 12 | (r1 = b64tab[asc.charAt(i++)]) << 6 | (r2 = b64tab[asc.charAt(i++)]);
    if (r1 === 64) {
      binArray.push(_fromCC(u24 >> 16 & 255));
    } else if (r2 === 64) {
      binArray.push(_fromCC(u24 >> 16 & 255, u24 >> 8 & 255));
    } else {
      binArray.push(_fromCC(u24 >> 16 & 255, u24 >> 8 & 255, u24 & 255));
    }
  }
  return binArray.join("");
}, "atobPolyfill");
var _atob = typeof atob === "function" ? (asc) => atob(_tidyB64(asc)) : _hasBuffer ? (asc) => Buffer.from(asc, "base64").toString("binary") : atobPolyfill;
var _toUint8Array = _hasBuffer ? (a) => _U8Afrom(Buffer.from(a, "base64")) : (a) => _U8Afrom(_atob(a).split("").map((c) => c.charCodeAt(0)));
var toUint8Array = /* @__PURE__ */ __name((a) => _toUint8Array(_unURI(a)), "toUint8Array");
var _decode = _hasBuffer ? (a) => Buffer.from(a, "base64").toString("utf8") : _TD ? (a) => _TD.decode(_toUint8Array(a)) : (a) => btou(_atob(a));
var _unURI = /* @__PURE__ */ __name((a) => _tidyB64(a.replace(/[-_]/g, (m0) => m0 == "-" ? "+" : "/")), "_unURI");
var decode = /* @__PURE__ */ __name((src) => _decode(_unURI(src)), "decode");
var isValid = /* @__PURE__ */ __name((src) => {
  if (typeof src !== "string")
    return false;
  const s = src.replace(/\s+/g, "").replace(/={0,2}$/, "");
  return !/[^\s0-9a-zA-Z\+/]/.test(s) || !/[^\s0-9a-zA-Z\-_]/.test(s);
}, "isValid");
var _noEnum = /* @__PURE__ */ __name((v) => {
  return {
    value: v,
    enumerable: false,
    writable: true,
    configurable: true
  };
}, "_noEnum");
var extendString = /* @__PURE__ */ __name(function() {
  const _add = /* @__PURE__ */ __name((name, body) => Object.defineProperty(String.prototype, name, _noEnum(body)), "_add");
  _add("fromBase64", function() {
    return decode(this);
  });
  _add("toBase64", function(urlsafe) {
    return encode(this, urlsafe);
  });
  _add("toBase64URI", function() {
    return encode(this, true);
  });
  _add("toBase64URL", function() {
    return encode(this, true);
  });
  _add("toUint8Array", function() {
    return toUint8Array(this);
  });
}, "extendString");
var extendUint8Array = /* @__PURE__ */ __name(function() {
  const _add = /* @__PURE__ */ __name((name, body) => Object.defineProperty(Uint8Array.prototype, name, _noEnum(body)), "_add");
  _add("toBase64", function(urlsafe) {
    return fromUint8Array(this, urlsafe);
  });
  _add("toBase64URI", function() {
    return fromUint8Array(this, true);
  });
  _add("toBase64URL", function() {
    return fromUint8Array(this, true);
  });
}, "extendUint8Array");
var extendBuiltins = /* @__PURE__ */ __name(() => {
  extendString();
  extendUint8Array();
}, "extendBuiltins");
var gBase64 = {
  version,
  VERSION,
  atob: _atob,
  atobPolyfill,
  btoa: _btoa,
  btoaPolyfill,
  fromBase64: decode,
  toBase64: encode,
  encode,
  encodeURI: encodeURI2,
  encodeURL: encodeURI2,
  utob,
  btou,
  decode,
  isValid,
  fromUint8Array,
  toUint8Array,
  extendString,
  extendUint8Array,
  extendBuiltins
};

// node_modules/@libsql/core/lib-esm/util.js
var supportedUrlLink = "https://github.com/libsql/libsql-client-ts#supported-urls";
function transactionModeToBegin(mode) {
  if (mode === "write") {
    return "BEGIN IMMEDIATE";
  } else if (mode === "read") {
    return "BEGIN TRANSACTION READONLY";
  } else if (mode === "deferred") {
    return "BEGIN DEFERRED";
  } else {
    throw RangeError('Unknown transaction mode, supported values are "write", "read" and "deferred"');
  }
}
__name(transactionModeToBegin, "transactionModeToBegin");
var ResultSetImpl = class {
  static {
    __name(this, "ResultSetImpl");
  }
  columns;
  columnTypes;
  rows;
  rowsAffected;
  lastInsertRowid;
  constructor(columns, columnTypes, rows, rowsAffected, lastInsertRowid) {
    this.columns = columns;
    this.columnTypes = columnTypes;
    this.rows = rows;
    this.rowsAffected = rowsAffected;
    this.lastInsertRowid = lastInsertRowid;
  }
  toJSON() {
    return {
      columns: this.columns,
      columnTypes: this.columnTypes,
      rows: this.rows.map(rowToJson),
      rowsAffected: this.rowsAffected,
      lastInsertRowid: this.lastInsertRowid !== void 0 ? "" + this.lastInsertRowid : null
    };
  }
};
function rowToJson(row) {
  return Array.prototype.map.call(row, valueToJson);
}
__name(rowToJson, "rowToJson");
function valueToJson(value) {
  if (typeof value === "bigint") {
    return "" + value;
  } else if (value instanceof ArrayBuffer) {
    return gBase64.fromUint8Array(new Uint8Array(value));
  } else {
    return value;
  }
}
__name(valueToJson, "valueToJson");

// node_modules/@libsql/core/lib-esm/config.js
var inMemoryMode = ":memory:";
function expandConfig(config, preferHttp) {
  if (typeof config !== "object") {
    throw new TypeError(`Expected client configuration as object, got ${typeof config}`);
  }
  let { url, authToken, tls, intMode, concurrency } = config;
  concurrency = Math.max(0, concurrency || 20);
  intMode ??= "number";
  let connectionQueryParams = [];
  if (url === inMemoryMode) {
    url = "file::memory:";
  }
  const uri = parseUri(url);
  const originalUriScheme = uri.scheme.toLowerCase();
  const isInMemoryMode = originalUriScheme === "file" && uri.path === inMemoryMode && uri.authority === void 0;
  let queryParamsDef;
  if (isInMemoryMode) {
    queryParamsDef = {
      cache: {
        values: ["shared", "private"],
        update: /* @__PURE__ */ __name((key, value) => connectionQueryParams.push(`${key}=${value}`), "update")
      }
    };
  } else {
    queryParamsDef = {
      tls: {
        values: ["0", "1"],
        update: /* @__PURE__ */ __name((_, value) => tls = value === "1", "update")
      },
      authToken: {
        update: /* @__PURE__ */ __name((_, value) => authToken = value, "update")
      }
    };
  }
  for (const { key, value } of uri.query?.pairs ?? []) {
    if (!Object.hasOwn(queryParamsDef, key)) {
      throw new LibsqlError(`Unsupported URL query parameter ${JSON.stringify(key)}`, "URL_PARAM_NOT_SUPPORTED");
    }
    const queryParamDef = queryParamsDef[key];
    if (queryParamDef.values !== void 0 && !queryParamDef.values.includes(value)) {
      throw new LibsqlError(`Unknown value for the "${key}" query argument: ${JSON.stringify(value)}. Supported values are: [${queryParamDef.values.map((x) => '"' + x + '"').join(", ")}]`, "URL_INVALID");
    }
    if (queryParamDef.update !== void 0) {
      queryParamDef?.update(key, value);
    }
  }
  const connectionQueryParamsString = connectionQueryParams.length === 0 ? "" : `?${connectionQueryParams.join("&")}`;
  const path = uri.path + connectionQueryParamsString;
  let scheme;
  if (originalUriScheme === "libsql") {
    if (tls === false) {
      if (uri.authority?.port === void 0) {
        throw new LibsqlError('A "libsql:" URL with ?tls=0 must specify an explicit port', "URL_INVALID");
      }
      scheme = preferHttp ? "http" : "ws";
    } else {
      scheme = preferHttp ? "https" : "wss";
    }
  } else {
    scheme = originalUriScheme;
  }
  if (scheme === "http" || scheme === "ws") {
    tls ??= false;
  } else {
    tls ??= true;
  }
  if (scheme !== "http" && scheme !== "ws" && scheme !== "https" && scheme !== "wss" && scheme !== "file") {
    throw new LibsqlError(`The client supports only "libsql:", "wss:", "ws:", "https:", "http:" and "file:" URLs, got ${JSON.stringify(uri.scheme + ":")}. For more information, please read ${supportedUrlLink}`, "URL_SCHEME_NOT_SUPPORTED");
  }
  if (intMode !== "number" && intMode !== "bigint" && intMode !== "string") {
    throw new TypeError(`Invalid value for intMode, expected "number", "bigint" or "string", got ${JSON.stringify(intMode)}`);
  }
  if (uri.fragment !== void 0) {
    throw new LibsqlError(`URL fragments are not supported: ${JSON.stringify("#" + uri.fragment)}`, "URL_INVALID");
  }
  if (isInMemoryMode) {
    return {
      scheme: "file",
      tls: false,
      path,
      intMode,
      concurrency,
      syncUrl: config.syncUrl,
      syncInterval: config.syncInterval,
      readYourWrites: config.readYourWrites,
      offline: config.offline,
      fetch: config.fetch,
      timeout: config.timeout,
      authToken: void 0,
      encryptionKey: void 0,
      remoteEncryptionKey: void 0,
      authority: void 0
    };
  }
  return {
    scheme,
    tls,
    authority: uri.authority,
    path,
    authToken,
    intMode,
    concurrency,
    encryptionKey: config.encryptionKey,
    remoteEncryptionKey: config.remoteEncryptionKey,
    syncUrl: config.syncUrl,
    syncInterval: config.syncInterval,
    readYourWrites: config.readYourWrites,
    offline: config.offline,
    fetch: config.fetch,
    timeout: config.timeout
  };
}
__name(expandConfig, "expandConfig");

// node_modules/@libsql/isomorphic-ws/web.mjs
var _WebSocket;
if (typeof WebSocket !== "undefined") {
  _WebSocket = WebSocket;
} else if (typeof global !== "undefined") {
  _WebSocket = global.WebSocket;
} else if (typeof window !== "undefined") {
  _WebSocket = window.WebSocket;
} else if (typeof self !== "undefined") {
  _WebSocket = self.WebSocket;
}

// node_modules/@libsql/hrana-client/lib-esm/client.js
var Client = class {
  static {
    __name(this, "Client");
  }
  /** @private */
  constructor() {
    this.intMode = "number";
  }
  /** Representation of integers returned from the database. See {@link IntMode}.
   *
   * This value is inherited by {@link Stream} objects created with {@link openStream}, but you can
   * override the integer mode for every stream by setting {@link Stream.intMode} on the stream.
   */
  intMode;
};

// node_modules/@libsql/hrana-client/lib-esm/errors.js
var ClientError = class extends Error {
  static {
    __name(this, "ClientError");
  }
  /** @private */
  constructor(message) {
    super(message);
    this.name = "ClientError";
  }
};
var ProtoError = class extends ClientError {
  static {
    __name(this, "ProtoError");
  }
  /** @private */
  constructor(message) {
    super(message);
    this.name = "ProtoError";
  }
};
var ResponseError = class extends ClientError {
  static {
    __name(this, "ResponseError");
  }
  code;
  /** @internal */
  proto;
  /** @private */
  constructor(message, protoError) {
    super(message);
    this.name = "ResponseError";
    this.code = protoError.code;
    this.proto = protoError;
    this.stack = void 0;
  }
};
var ClosedError = class extends ClientError {
  static {
    __name(this, "ClosedError");
  }
  /** @private */
  constructor(message, cause) {
    if (cause !== void 0) {
      super(`${message}: ${cause}`);
      this.cause = cause;
    } else {
      super(message);
    }
    this.name = "ClosedError";
  }
};
var WebSocketUnsupportedError = class extends ClientError {
  static {
    __name(this, "WebSocketUnsupportedError");
  }
  /** @private */
  constructor(message) {
    super(message);
    this.name = "WebSocketUnsupportedError";
  }
};
var WebSocketError = class extends ClientError {
  static {
    __name(this, "WebSocketError");
  }
  /** @private */
  constructor(message) {
    super(message);
    this.name = "WebSocketError";
  }
};
var HttpServerError = class extends ClientError {
  static {
    __name(this, "HttpServerError");
  }
  status;
  /** @private */
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "HttpServerError";
  }
};
var ProtocolVersionError = class extends ClientError {
  static {
    __name(this, "ProtocolVersionError");
  }
  /** @private */
  constructor(message) {
    super(message);
    this.name = "ProtocolVersionError";
  }
};
var InternalError = class extends ClientError {
  static {
    __name(this, "InternalError");
  }
  /** @private */
  constructor(message) {
    super(message);
    this.name = "InternalError";
  }
};
var MisuseError = class extends ClientError {
  static {
    __name(this, "MisuseError");
  }
  /** @private */
  constructor(message) {
    super(message);
    this.name = "MisuseError";
  }
};

// node_modules/@libsql/hrana-client/lib-esm/encoding/json/decode.js
function string(value) {
  if (typeof value === "string") {
    return value;
  }
  throw typeError(value, "string");
}
__name(string, "string");
function stringOpt(value) {
  if (value === null || value === void 0) {
    return void 0;
  } else if (typeof value === "string") {
    return value;
  }
  throw typeError(value, "string or null");
}
__name(stringOpt, "stringOpt");
function number(value) {
  if (typeof value === "number") {
    return value;
  }
  throw typeError(value, "number");
}
__name(number, "number");
function boolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  throw typeError(value, "boolean");
}
__name(boolean, "boolean");
function array(value) {
  if (Array.isArray(value)) {
    return value;
  }
  throw typeError(value, "array");
}
__name(array, "array");
function object(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  throw typeError(value, "object");
}
__name(object, "object");
function arrayObjectsMap(value, fun) {
  return array(value).map((elemValue) => fun(object(elemValue)));
}
__name(arrayObjectsMap, "arrayObjectsMap");
function typeError(value, expected) {
  if (value === void 0) {
    return new ProtoError(`Expected ${expected}, but the property was missing`);
  }
  let received = typeof value;
  if (value === null) {
    received = "null";
  } else if (Array.isArray(value)) {
    received = "array";
  }
  return new ProtoError(`Expected ${expected}, received ${received}`);
}
__name(typeError, "typeError");
function readJsonObject(value, fun) {
  return fun(object(value));
}
__name(readJsonObject, "readJsonObject");

// node_modules/@libsql/hrana-client/lib-esm/encoding/json/encode.js
var ObjectWriter = class {
  static {
    __name(this, "ObjectWriter");
  }
  #output;
  #isFirst;
  constructor(output) {
    this.#output = output;
    this.#isFirst = false;
  }
  begin() {
    this.#output.push("{");
    this.#isFirst = true;
  }
  end() {
    this.#output.push("}");
    this.#isFirst = false;
  }
  #key(name) {
    if (this.#isFirst) {
      this.#output.push('"');
      this.#isFirst = false;
    } else {
      this.#output.push(',"');
    }
    this.#output.push(name);
    this.#output.push('":');
  }
  string(name, value) {
    this.#key(name);
    this.#output.push(JSON.stringify(value));
  }
  stringRaw(name, value) {
    this.#key(name);
    this.#output.push('"');
    this.#output.push(value);
    this.#output.push('"');
  }
  number(name, value) {
    this.#key(name);
    this.#output.push("" + value);
  }
  boolean(name, value) {
    this.#key(name);
    this.#output.push(value ? "true" : "false");
  }
  object(name, value, valueFun) {
    this.#key(name);
    this.begin();
    valueFun(this, value);
    this.end();
  }
  arrayObjects(name, values, valueFun) {
    this.#key(name);
    this.#output.push("[");
    for (let i = 0; i < values.length; ++i) {
      if (i !== 0) {
        this.#output.push(",");
      }
      this.begin();
      valueFun(this, values[i]);
      this.end();
    }
    this.#output.push("]");
  }
};
function writeJsonObject(value, fun) {
  const output = [];
  const writer = new ObjectWriter(output);
  writer.begin();
  fun(writer, value);
  writer.end();
  return output.join("");
}
__name(writeJsonObject, "writeJsonObject");

// node_modules/@libsql/hrana-client/lib-esm/encoding/protobuf/util.js
var VARINT = 0;
var FIXED_64 = 1;
var LENGTH_DELIMITED = 2;
var FIXED_32 = 5;

// node_modules/@libsql/hrana-client/lib-esm/encoding/protobuf/decode.js
var MessageReader = class {
  static {
    __name(this, "MessageReader");
  }
  #array;
  #view;
  #pos;
  constructor(array2) {
    this.#array = array2;
    this.#view = new DataView(array2.buffer, array2.byteOffset, array2.byteLength);
    this.#pos = 0;
  }
  varint() {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = this.#array[this.#pos++];
      value |= (byte & 127) << shift;
      if (!(byte & 128)) {
        break;
      }
    }
    return value;
  }
  varintBig() {
    let value = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const byte = this.#array[this.#pos++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) {
        break;
      }
    }
    return value;
  }
  bytes(length) {
    const array2 = new Uint8Array(this.#array.buffer, this.#array.byteOffset + this.#pos, length);
    this.#pos += length;
    return array2;
  }
  double() {
    const value = this.#view.getFloat64(this.#pos, true);
    this.#pos += 8;
    return value;
  }
  skipVarint() {
    for (; ; ) {
      const byte = this.#array[this.#pos++];
      if (!(byte & 128)) {
        break;
      }
    }
  }
  skip(count) {
    this.#pos += count;
  }
  eof() {
    return this.#pos >= this.#array.byteLength;
  }
};
var FieldReader = class {
  static {
    __name(this, "FieldReader");
  }
  #reader;
  #wireType;
  constructor(reader) {
    this.#reader = reader;
    this.#wireType = -1;
  }
  setup(wireType) {
    this.#wireType = wireType;
  }
  #expect(expectedWireType) {
    if (this.#wireType !== expectedWireType) {
      throw new ProtoError(`Expected wire type ${expectedWireType}, got ${this.#wireType}`);
    }
    this.#wireType = -1;
  }
  bytes() {
    this.#expect(LENGTH_DELIMITED);
    const length = this.#reader.varint();
    return this.#reader.bytes(length);
  }
  string() {
    return new TextDecoder().decode(this.bytes());
  }
  message(def) {
    return readProtobufMessage(this.bytes(), def);
  }
  int32() {
    this.#expect(VARINT);
    return this.#reader.varint();
  }
  uint32() {
    return this.int32();
  }
  bool() {
    return this.int32() !== 0;
  }
  uint64() {
    this.#expect(VARINT);
    return this.#reader.varintBig();
  }
  sint64() {
    const value = this.uint64();
    return value >> 1n ^ -(value & 1n);
  }
  double() {
    this.#expect(FIXED_64);
    return this.#reader.double();
  }
  maybeSkip() {
    if (this.#wireType < 0) {
      return;
    } else if (this.#wireType === VARINT) {
      this.#reader.skipVarint();
    } else if (this.#wireType === FIXED_64) {
      this.#reader.skip(8);
    } else if (this.#wireType === LENGTH_DELIMITED) {
      const length = this.#reader.varint();
      this.#reader.skip(length);
    } else if (this.#wireType === FIXED_32) {
      this.#reader.skip(4);
    } else {
      throw new ProtoError(`Unexpected wire type ${this.#wireType}`);
    }
    this.#wireType = -1;
  }
};
function readProtobufMessage(data, def) {
  const msgReader = new MessageReader(data);
  const fieldReader = new FieldReader(msgReader);
  let value = def.default();
  while (!msgReader.eof()) {
    const key = msgReader.varint();
    const tag = key >> 3;
    const wireType = key & 7;
    fieldReader.setup(wireType);
    const tagFun = def[tag];
    if (tagFun !== void 0) {
      const returnedValue = tagFun(fieldReader, value);
      if (returnedValue !== void 0) {
        value = returnedValue;
      }
    }
    fieldReader.maybeSkip();
  }
  return value;
}
__name(readProtobufMessage, "readProtobufMessage");

// node_modules/@libsql/hrana-client/lib-esm/encoding/protobuf/encode.js
var MessageWriter = class _MessageWriter {
  static {
    __name(this, "MessageWriter");
  }
  #buf;
  #array;
  #view;
  #pos;
  constructor() {
    this.#buf = new ArrayBuffer(256);
    this.#array = new Uint8Array(this.#buf);
    this.#view = new DataView(this.#buf);
    this.#pos = 0;
  }
  #ensure(extra) {
    if (this.#pos + extra <= this.#buf.byteLength) {
      return;
    }
    let newCap = this.#buf.byteLength;
    while (newCap < this.#pos + extra) {
      newCap *= 2;
    }
    const newBuf = new ArrayBuffer(newCap);
    const newArray = new Uint8Array(newBuf);
    const newView = new DataView(newBuf);
    newArray.set(new Uint8Array(this.#buf, 0, this.#pos));
    this.#buf = newBuf;
    this.#array = newArray;
    this.#view = newView;
  }
  #varint(value) {
    this.#ensure(5);
    value = 0 | value;
    do {
      let byte = value & 127;
      value >>>= 7;
      byte |= value ? 128 : 0;
      this.#array[this.#pos++] = byte;
    } while (value);
  }
  #varintBig(value) {
    this.#ensure(10);
    value = value & 0xffffffffffffffffn;
    do {
      let byte = Number(value & 0x7fn);
      value >>= 7n;
      byte |= value ? 128 : 0;
      this.#array[this.#pos++] = byte;
    } while (value);
  }
  #tag(tag, wireType) {
    this.#varint(tag << 3 | wireType);
  }
  bytes(tag, value) {
    this.#tag(tag, LENGTH_DELIMITED);
    this.#varint(value.byteLength);
    this.#ensure(value.byteLength);
    this.#array.set(value, this.#pos);
    this.#pos += value.byteLength;
  }
  string(tag, value) {
    this.bytes(tag, new TextEncoder().encode(value));
  }
  message(tag, value, fun) {
    const writer = new _MessageWriter();
    fun(writer, value);
    this.bytes(tag, writer.data());
  }
  int32(tag, value) {
    this.#tag(tag, VARINT);
    this.#varint(value);
  }
  uint32(tag, value) {
    this.int32(tag, value);
  }
  bool(tag, value) {
    this.int32(tag, value ? 1 : 0);
  }
  sint64(tag, value) {
    this.#tag(tag, VARINT);
    this.#varintBig(value << 1n ^ value >> 63n);
  }
  double(tag, value) {
    this.#tag(tag, FIXED_64);
    this.#ensure(8);
    this.#view.setFloat64(this.#pos, value, true);
    this.#pos += 8;
  }
  data() {
    return new Uint8Array(this.#buf, 0, this.#pos);
  }
};
function writeProtobufMessage(value, fun) {
  const w = new MessageWriter();
  fun(w, value);
  return w.data();
}
__name(writeProtobufMessage, "writeProtobufMessage");

// node_modules/@libsql/hrana-client/lib-esm/id_alloc.js
var IdAlloc = class {
  static {
    __name(this, "IdAlloc");
  }
  // Set of all allocated ids
  #usedIds;
  // Set of all free ids lower than `#usedIds.size`
  #freeIds;
  constructor() {
    this.#usedIds = /* @__PURE__ */ new Set();
    this.#freeIds = /* @__PURE__ */ new Set();
  }
  // Returns an id that was free, and marks it as used.
  alloc() {
    for (const freeId2 of this.#freeIds) {
      this.#freeIds.delete(freeId2);
      this.#usedIds.add(freeId2);
      if (!this.#usedIds.has(this.#usedIds.size - 1)) {
        this.#freeIds.add(this.#usedIds.size - 1);
      }
      return freeId2;
    }
    const freeId = this.#usedIds.size;
    this.#usedIds.add(freeId);
    return freeId;
  }
  free(id) {
    if (!this.#usedIds.delete(id)) {
      throw new InternalError("Freeing an id that is not allocated");
    }
    this.#freeIds.delete(this.#usedIds.size);
    if (id < this.#usedIds.size) {
      this.#freeIds.add(id);
    }
  }
};

// node_modules/@libsql/hrana-client/lib-esm/util.js
function impossible(value, message) {
  throw new InternalError(message);
}
__name(impossible, "impossible");

// node_modules/@libsql/hrana-client/lib-esm/value.js
function valueToProto(value) {
  if (value === null) {
    return null;
  } else if (typeof value === "string") {
    return value;
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RangeError("Only finite numbers (not Infinity or NaN) can be passed as arguments");
    }
    return value;
  } else if (typeof value === "bigint") {
    if (value < minInteger || value > maxInteger) {
      throw new RangeError("This bigint value is too large to be represented as a 64-bit integer and passed as argument");
    }
    return value;
  } else if (typeof value === "boolean") {
    return value ? 1n : 0n;
  } else if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  } else if (value instanceof Uint8Array) {
    return value;
  } else if (value instanceof Date) {
    return +value.valueOf();
  } else if (typeof value === "object") {
    return "" + value.toString();
  } else {
    throw new TypeError("Unsupported type of value");
  }
}
__name(valueToProto, "valueToProto");
var minInteger = -9223372036854775808n;
var maxInteger = 9223372036854775807n;
function valueFromProto(value, intMode) {
  if (value === null) {
    return null;
  } else if (typeof value === "number") {
    return value;
  } else if (typeof value === "string") {
    return value;
  } else if (typeof value === "bigint") {
    if (intMode === "number") {
      const num = Number(value);
      if (!Number.isSafeInteger(num)) {
        throw new RangeError("Received integer which is too large to be safely represented as a JavaScript number");
      }
      return num;
    } else if (intMode === "bigint") {
      return value;
    } else if (intMode === "string") {
      return "" + value;
    } else {
      throw new MisuseError("Invalid value for IntMode");
    }
  } else if (value instanceof Uint8Array) {
    return value.slice().buffer;
  } else if (value === void 0) {
    throw new ProtoError("Received unrecognized type of Value");
  } else {
    throw impossible(value, "Impossible type of Value");
  }
}
__name(valueFromProto, "valueFromProto");

// node_modules/@libsql/hrana-client/lib-esm/result.js
function stmtResultFromProto(result) {
  return {
    affectedRowCount: result.affectedRowCount,
    lastInsertRowid: result.lastInsertRowid,
    columnNames: result.cols.map((col) => col.name),
    columnDecltypes: result.cols.map((col) => col.decltype)
  };
}
__name(stmtResultFromProto, "stmtResultFromProto");
function rowsResultFromProto(result, intMode) {
  const stmtResult = stmtResultFromProto(result);
  const rows = result.rows.map((row) => rowFromProto(stmtResult.columnNames, row, intMode));
  return { ...stmtResult, rows };
}
__name(rowsResultFromProto, "rowsResultFromProto");
function rowResultFromProto(result, intMode) {
  const stmtResult = stmtResultFromProto(result);
  let row;
  if (result.rows.length > 0) {
    row = rowFromProto(stmtResult.columnNames, result.rows[0], intMode);
  }
  return { ...stmtResult, row };
}
__name(rowResultFromProto, "rowResultFromProto");
function valueResultFromProto(result, intMode) {
  const stmtResult = stmtResultFromProto(result);
  let value;
  if (result.rows.length > 0 && stmtResult.columnNames.length > 0) {
    value = valueFromProto(result.rows[0][0], intMode);
  }
  return { ...stmtResult, value };
}
__name(valueResultFromProto, "valueResultFromProto");
function rowFromProto(colNames, values, intMode) {
  const row = {};
  Object.defineProperty(row, "length", { value: values.length });
  for (let i = 0; i < values.length; ++i) {
    const value = valueFromProto(values[i], intMode);
    Object.defineProperty(row, i, { value });
    const colName = colNames[i];
    if (colName !== void 0 && !Object.hasOwn(row, colName)) {
      Object.defineProperty(row, colName, { value, enumerable: true, configurable: true, writable: true });
    }
  }
  return row;
}
__name(rowFromProto, "rowFromProto");
function errorFromProto(error) {
  return new ResponseError(error.message, error);
}
__name(errorFromProto, "errorFromProto");

// node_modules/@libsql/hrana-client/lib-esm/sql.js
var Sql = class {
  static {
    __name(this, "Sql");
  }
  #owner;
  #sqlId;
  #closed;
  /** @private */
  constructor(owner, sqlId) {
    this.#owner = owner;
    this.#sqlId = sqlId;
    this.#closed = void 0;
  }
  /** @private */
  _getSqlId(owner) {
    if (this.#owner !== owner) {
      throw new MisuseError("Attempted to use SQL text opened with other object");
    } else if (this.#closed !== void 0) {
      throw new ClosedError("SQL text is closed", this.#closed);
    }
    return this.#sqlId;
  }
  /** Remove the SQL text from the server, releasing resouces. */
  close() {
    this._setClosed(new ClientError("SQL text was manually closed"));
  }
  /** @private */
  _setClosed(error) {
    if (this.#closed === void 0) {
      this.#closed = error;
      this.#owner._closeSql(this.#sqlId);
    }
  }
  /** True if the SQL text is closed (removed from the server). */
  get closed() {
    return this.#closed !== void 0;
  }
};
function sqlToProto(owner, sql) {
  if (sql instanceof Sql) {
    return { sqlId: sql._getSqlId(owner) };
  } else {
    return { sql: "" + sql };
  }
}
__name(sqlToProto, "sqlToProto");

// node_modules/@libsql/hrana-client/lib-esm/queue.js
var Queue = class {
  static {
    __name(this, "Queue");
  }
  #pushStack;
  #shiftStack;
  constructor() {
    this.#pushStack = [];
    this.#shiftStack = [];
  }
  get length() {
    return this.#pushStack.length + this.#shiftStack.length;
  }
  push(elem) {
    this.#pushStack.push(elem);
  }
  shift() {
    if (this.#shiftStack.length === 0 && this.#pushStack.length > 0) {
      this.#shiftStack = this.#pushStack.reverse();
      this.#pushStack = [];
    }
    return this.#shiftStack.pop();
  }
  first() {
    return this.#shiftStack.length !== 0 ? this.#shiftStack[this.#shiftStack.length - 1] : this.#pushStack[0];
  }
};

// node_modules/@libsql/hrana-client/lib-esm/stmt.js
var Stmt = class {
  static {
    __name(this, "Stmt");
  }
  /** The SQL statement text. */
  sql;
  /** @private */
  _args;
  /** @private */
  _namedArgs;
  /** Initialize the statement with given SQL text. */
  constructor(sql) {
    this.sql = sql;
    this._args = [];
    this._namedArgs = /* @__PURE__ */ new Map();
  }
  /** Binds positional parameters from the given `values`. All previous positional bindings are cleared. */
  bindIndexes(values) {
    this._args.length = 0;
    for (const value of values) {
      this._args.push(valueToProto(value));
    }
    return this;
  }
  /** Binds a parameter by a 1-based index. */
  bindIndex(index, value) {
    if (index !== (index | 0) || index <= 0) {
      throw new RangeError("Index of a positional argument must be positive integer");
    }
    while (this._args.length < index) {
      this._args.push(null);
    }
    this._args[index - 1] = valueToProto(value);
    return this;
  }
  /** Binds a parameter by name. */
  bindName(name, value) {
    this._namedArgs.set(name, valueToProto(value));
    return this;
  }
  /** Clears all bindings. */
  unbindAll() {
    this._args.length = 0;
    this._namedArgs.clear();
    return this;
  }
};
function stmtToProto(sqlOwner, stmt, wantRows) {
  let inSql;
  let args = [];
  let namedArgs = [];
  if (stmt instanceof Stmt) {
    inSql = stmt.sql;
    args = stmt._args;
    for (const [name, value] of stmt._namedArgs.entries()) {
      namedArgs.push({ name, value });
    }
  } else if (Array.isArray(stmt)) {
    inSql = stmt[0];
    if (Array.isArray(stmt[1])) {
      args = stmt[1].map((arg) => valueToProto(arg));
    } else {
      namedArgs = Object.entries(stmt[1]).map(([name, value]) => {
        return { name, value: valueToProto(value) };
      });
    }
  } else {
    inSql = stmt;
  }
  const { sql, sqlId } = sqlToProto(sqlOwner, inSql);
  return { sql, sqlId, args, namedArgs, wantRows };
}
__name(stmtToProto, "stmtToProto");

// node_modules/@libsql/hrana-client/lib-esm/batch.js
var Batch = class {
  static {
    __name(this, "Batch");
  }
  /** @private */
  _stream;
  #useCursor;
  /** @private */
  _steps;
  #executed;
  /** @private */
  constructor(stream, useCursor) {
    this._stream = stream;
    this.#useCursor = useCursor;
    this._steps = [];
    this.#executed = false;
  }
  /** Return a builder for adding a step to the batch. */
  step() {
    return new BatchStep(this);
  }
  /** Execute the batch. */
  execute() {
    if (this.#executed) {
      throw new MisuseError("This batch has already been executed");
    }
    this.#executed = true;
    const batch = {
      steps: this._steps.map((step) => step.proto)
    };
    if (this.#useCursor) {
      return executeCursor(this._stream, this._steps, batch);
    } else {
      return executeRegular(this._stream, this._steps, batch);
    }
  }
};
function executeRegular(stream, steps, batch) {
  return stream._batch(batch).then((result) => {
    for (let step = 0; step < steps.length; ++step) {
      const stepResult = result.stepResults.get(step);
      const stepError = result.stepErrors.get(step);
      steps[step].callback(stepResult, stepError);
    }
  });
}
__name(executeRegular, "executeRegular");
async function executeCursor(stream, steps, batch) {
  const cursor = await stream._openCursor(batch);
  try {
    let nextStep = 0;
    let beginEntry = void 0;
    let rows = [];
    for (; ; ) {
      const entry = await cursor.next();
      if (entry === void 0) {
        break;
      }
      if (entry.type === "step_begin") {
        if (entry.step < nextStep || entry.step >= steps.length) {
          throw new ProtoError("Server produced StepBeginEntry for unexpected step");
        } else if (beginEntry !== void 0) {
          throw new ProtoError("Server produced StepBeginEntry before terminating previous step");
        }
        for (let step = nextStep; step < entry.step; ++step) {
          steps[step].callback(void 0, void 0);
        }
        nextStep = entry.step + 1;
        beginEntry = entry;
        rows = [];
      } else if (entry.type === "step_end") {
        if (beginEntry === void 0) {
          throw new ProtoError("Server produced StepEndEntry but no step is active");
        }
        const stmtResult = {
          cols: beginEntry.cols,
          rows,
          affectedRowCount: entry.affectedRowCount,
          lastInsertRowid: entry.lastInsertRowid
        };
        steps[beginEntry.step].callback(stmtResult, void 0);
        beginEntry = void 0;
        rows = [];
      } else if (entry.type === "step_error") {
        if (beginEntry === void 0) {
          if (entry.step >= steps.length) {
            throw new ProtoError("Server produced StepErrorEntry for unexpected step");
          }
          for (let step = nextStep; step < entry.step; ++step) {
            steps[step].callback(void 0, void 0);
          }
        } else {
          if (entry.step !== beginEntry.step) {
            throw new ProtoError("Server produced StepErrorEntry for unexpected step");
          }
          beginEntry = void 0;
          rows = [];
        }
        steps[entry.step].callback(void 0, entry.error);
        nextStep = entry.step + 1;
      } else if (entry.type === "row") {
        if (beginEntry === void 0) {
          throw new ProtoError("Server produced RowEntry but no step is active");
        }
        rows.push(entry.row);
      } else if (entry.type === "error") {
        throw errorFromProto(entry.error);
      } else if (entry.type === "none") {
        throw new ProtoError("Server produced unrecognized CursorEntry");
      } else {
        throw impossible(entry, "Impossible CursorEntry");
      }
    }
    if (beginEntry !== void 0) {
      throw new ProtoError("Server closed Cursor before terminating active step");
    }
    for (let step = nextStep; step < steps.length; ++step) {
      steps[step].callback(void 0, void 0);
    }
  } finally {
    cursor.close();
  }
}
__name(executeCursor, "executeCursor");
var BatchStep = class {
  static {
    __name(this, "BatchStep");
  }
  /** @private */
  _batch;
  #conds;
  /** @private */
  _index;
  /** @private */
  constructor(batch) {
    this._batch = batch;
    this.#conds = [];
    this._index = void 0;
  }
  /** Add the condition that needs to be satisfied to execute the statement. If you use this method multiple
   * times, we join the conditions with a logical AND. */
  condition(cond) {
    this.#conds.push(cond._proto);
    return this;
  }
  /** Add a statement that returns rows. */
  query(stmt) {
    return this.#add(stmt, true, rowsResultFromProto);
  }
  /** Add a statement that returns at most a single row. */
  queryRow(stmt) {
    return this.#add(stmt, true, rowResultFromProto);
  }
  /** Add a statement that returns at most a single value. */
  queryValue(stmt) {
    return this.#add(stmt, true, valueResultFromProto);
  }
  /** Add a statement without returning rows. */
  run(stmt) {
    return this.#add(stmt, false, stmtResultFromProto);
  }
  #add(inStmt, wantRows, fromProto) {
    if (this._index !== void 0) {
      throw new MisuseError("This BatchStep has already been added to the batch");
    }
    const stmt = stmtToProto(this._batch._stream._sqlOwner(), inStmt, wantRows);
    let condition;
    if (this.#conds.length === 0) {
      condition = void 0;
    } else if (this.#conds.length === 1) {
      condition = this.#conds[0];
    } else {
      condition = { type: "and", conds: this.#conds.slice() };
    }
    const proto = { stmt, condition };
    return new Promise((outputCallback, errorCallback) => {
      const callback = /* @__PURE__ */ __name((stepResult, stepError) => {
        if (stepResult !== void 0 && stepError !== void 0) {
          errorCallback(new ProtoError("Server returned both result and error"));
        } else if (stepError !== void 0) {
          errorCallback(errorFromProto(stepError));
        } else if (stepResult !== void 0) {
          outputCallback(fromProto(stepResult, this._batch._stream.intMode));
        } else {
          outputCallback(void 0);
        }
      }, "callback");
      this._index = this._batch._steps.length;
      this._batch._steps.push({ proto, callback });
    });
  }
};
var BatchCond = class _BatchCond {
  static {
    __name(this, "BatchCond");
  }
  /** @private */
  _batch;
  /** @private */
  _proto;
  /** @private */
  constructor(batch, proto) {
    this._batch = batch;
    this._proto = proto;
  }
  /** Create a condition that evaluates to true when the given step executes successfully.
   *
   * If the given step fails error or is skipped because its condition evaluated to false, this
   * condition evaluates to false.
   */
  static ok(step) {
    return new _BatchCond(step._batch, { type: "ok", step: stepIndex(step) });
  }
  /** Create a condition that evaluates to true when the given step fails.
   *
   * If the given step succeeds or is skipped because its condition evaluated to false, this condition
   * evaluates to false.
   */
  static error(step) {
    return new _BatchCond(step._batch, { type: "error", step: stepIndex(step) });
  }
  /** Create a condition that is a logical negation of another condition.
   */
  static not(cond) {
    return new _BatchCond(cond._batch, { type: "not", cond: cond._proto });
  }
  /** Create a condition that is a logical AND of other conditions.
   */
  static and(batch, conds) {
    for (const cond of conds) {
      checkCondBatch(batch, cond);
    }
    return new _BatchCond(batch, { type: "and", conds: conds.map((e) => e._proto) });
  }
  /** Create a condition that is a logical OR of other conditions.
   */
  static or(batch, conds) {
    for (const cond of conds) {
      checkCondBatch(batch, cond);
    }
    return new _BatchCond(batch, { type: "or", conds: conds.map((e) => e._proto) });
  }
  /** Create a condition that evaluates to true when the SQL connection is in autocommit mode (not inside an
   * explicit transaction). This requires protocol version 3 or higher.
   */
  static isAutocommit(batch) {
    batch._stream.client()._ensureVersion(3, "BatchCond.isAutocommit()");
    return new _BatchCond(batch, { type: "is_autocommit" });
  }
};
function stepIndex(step) {
  if (step._index === void 0) {
    throw new MisuseError("Cannot add a condition referencing a step that has not been added to the batch");
  }
  return step._index;
}
__name(stepIndex, "stepIndex");
function checkCondBatch(expectedBatch, cond) {
  if (cond._batch !== expectedBatch) {
    throw new MisuseError("Cannot mix BatchCond objects for different Batch objects");
  }
}
__name(checkCondBatch, "checkCondBatch");

// node_modules/@libsql/hrana-client/lib-esm/describe.js
function describeResultFromProto(result) {
  return {
    paramNames: result.params.map((p) => p.name),
    columns: result.cols,
    isExplain: result.isExplain,
    isReadonly: result.isReadonly
  };
}
__name(describeResultFromProto, "describeResultFromProto");

// node_modules/@libsql/hrana-client/lib-esm/stream.js
var Stream = class {
  static {
    __name(this, "Stream");
  }
  /** @private */
  constructor(intMode) {
    this.intMode = intMode;
  }
  /** Execute a statement and return rows. */
  query(stmt) {
    return this.#execute(stmt, true, rowsResultFromProto);
  }
  /** Execute a statement and return at most a single row. */
  queryRow(stmt) {
    return this.#execute(stmt, true, rowResultFromProto);
  }
  /** Execute a statement and return at most a single value. */
  queryValue(stmt) {
    return this.#execute(stmt, true, valueResultFromProto);
  }
  /** Execute a statement without returning rows. */
  run(stmt) {
    return this.#execute(stmt, false, stmtResultFromProto);
  }
  #execute(inStmt, wantRows, fromProto) {
    const stmt = stmtToProto(this._sqlOwner(), inStmt, wantRows);
    return this._execute(stmt).then((r) => fromProto(r, this.intMode));
  }
  /** Return a builder for creating and executing a batch.
   *
   * If `useCursor` is true, the batch will be executed using a Hrana cursor, which will stream results from
   * the server to the client, which consumes less memory on the server. This requires protocol version 3 or
   * higher.
   */
  batch(useCursor = false) {
    return new Batch(this, useCursor);
  }
  /** Parse and analyze a statement. This requires protocol version 2 or higher. */
  describe(inSql) {
    const protoSql = sqlToProto(this._sqlOwner(), inSql);
    return this._describe(protoSql).then(describeResultFromProto);
  }
  /** Execute a sequence of statements separated by semicolons. This requires protocol version 2 or higher.
   * */
  sequence(inSql) {
    const protoSql = sqlToProto(this._sqlOwner(), inSql);
    return this._sequence(protoSql);
  }
  /** Representation of integers returned from the database. See {@link IntMode}.
   *
   * This value affects the results of all operations on this stream.
   */
  intMode;
};

// node_modules/@libsql/hrana-client/lib-esm/cursor.js
var Cursor = class {
  static {
    __name(this, "Cursor");
  }
};

// node_modules/@libsql/hrana-client/lib-esm/ws/cursor.js
var fetchChunkSize = 1e3;
var fetchQueueSize = 10;
var WsCursor = class extends Cursor {
  static {
    __name(this, "WsCursor");
  }
  #client;
  #stream;
  #cursorId;
  #entryQueue;
  #fetchQueue;
  #closed;
  #done;
  /** @private */
  constructor(client, stream, cursorId) {
    super();
    this.#client = client;
    this.#stream = stream;
    this.#cursorId = cursorId;
    this.#entryQueue = new Queue();
    this.#fetchQueue = new Queue();
    this.#closed = void 0;
    this.#done = false;
  }
  /** Fetch the next entry from the cursor. */
  async next() {
    for (; ; ) {
      if (this.#closed !== void 0) {
        throw new ClosedError("Cursor is closed", this.#closed);
      }
      while (!this.#done && this.#fetchQueue.length < fetchQueueSize) {
        this.#fetchQueue.push(this.#fetch());
      }
      const entry = this.#entryQueue.shift();
      if (this.#done || entry !== void 0) {
        return entry;
      }
      await this.#fetchQueue.shift().then((response) => {
        if (response === void 0) {
          return;
        }
        for (const entry2 of response.entries) {
          this.#entryQueue.push(entry2);
        }
        this.#done ||= response.done;
      });
    }
  }
  #fetch() {
    return this.#stream._sendCursorRequest(this, {
      type: "fetch_cursor",
      cursorId: this.#cursorId,
      maxCount: fetchChunkSize
    }).then((resp) => resp, (error) => {
      this._setClosed(error);
      return void 0;
    });
  }
  /** @private */
  _setClosed(error) {
    if (this.#closed !== void 0) {
      return;
    }
    this.#closed = error;
    this.#stream._sendCursorRequest(this, {
      type: "close_cursor",
      cursorId: this.#cursorId
    }).catch(() => void 0);
    this.#stream._cursorClosed(this);
  }
  /** Close the cursor. */
  close() {
    this._setClosed(new ClientError("Cursor was manually closed"));
  }
  /** True if the cursor is closed. */
  get closed() {
    return this.#closed !== void 0;
  }
};

// node_modules/@libsql/hrana-client/lib-esm/ws/stream.js
var WsStream = class _WsStream extends Stream {
  static {
    __name(this, "WsStream");
  }
  #client;
  #streamId;
  #queue;
  #cursor;
  #closing;
  #closed;
  /** @private */
  static open(client) {
    const streamId = client._streamIdAlloc.alloc();
    const stream = new _WsStream(client, streamId);
    const responseCallback = /* @__PURE__ */ __name(() => void 0, "responseCallback");
    const errorCallback = /* @__PURE__ */ __name((e) => stream.#setClosed(e), "errorCallback");
    const request = { type: "open_stream", streamId };
    client._sendRequest(request, { responseCallback, errorCallback });
    return stream;
  }
  /** @private */
  constructor(client, streamId) {
    super(client.intMode);
    this.#client = client;
    this.#streamId = streamId;
    this.#queue = new Queue();
    this.#cursor = void 0;
    this.#closing = false;
    this.#closed = void 0;
  }
  /** Get the {@link WsClient} object that this stream belongs to. */
  client() {
    return this.#client;
  }
  /** @private */
  _sqlOwner() {
    return this.#client;
  }
  /** @private */
  _execute(stmt) {
    return this.#sendStreamRequest({
      type: "execute",
      streamId: this.#streamId,
      stmt
    }).then((response) => {
      return response.result;
    });
  }
  /** @private */
  _batch(batch) {
    return this.#sendStreamRequest({
      type: "batch",
      streamId: this.#streamId,
      batch
    }).then((response) => {
      return response.result;
    });
  }
  /** @private */
  _describe(protoSql) {
    this.#client._ensureVersion(2, "describe()");
    return this.#sendStreamRequest({
      type: "describe",
      streamId: this.#streamId,
      sql: protoSql.sql,
      sqlId: protoSql.sqlId
    }).then((response) => {
      return response.result;
    });
  }
  /** @private */
  _sequence(protoSql) {
    this.#client._ensureVersion(2, "sequence()");
    return this.#sendStreamRequest({
      type: "sequence",
      streamId: this.#streamId,
      sql: protoSql.sql,
      sqlId: protoSql.sqlId
    }).then((_response) => {
      return void 0;
    });
  }
  /** Check whether the SQL connection underlying this stream is in autocommit state (i.e., outside of an
   * explicit transaction). This requires protocol version 3 or higher.
   */
  getAutocommit() {
    this.#client._ensureVersion(3, "getAutocommit()");
    return this.#sendStreamRequest({
      type: "get_autocommit",
      streamId: this.#streamId
    }).then((response) => {
      return response.isAutocommit;
    });
  }
  #sendStreamRequest(request) {
    return new Promise((responseCallback, errorCallback) => {
      this.#pushToQueue({ type: "request", request, responseCallback, errorCallback });
    });
  }
  /** @private */
  _openCursor(batch) {
    this.#client._ensureVersion(3, "cursor");
    return new Promise((cursorCallback, errorCallback) => {
      this.#pushToQueue({ type: "cursor", batch, cursorCallback, errorCallback });
    });
  }
  /** @private */
  _sendCursorRequest(cursor, request) {
    if (cursor !== this.#cursor) {
      throw new InternalError("Cursor not associated with the stream attempted to execute a request");
    }
    return new Promise((responseCallback, errorCallback) => {
      if (this.#closed !== void 0) {
        errorCallback(new ClosedError("Stream is closed", this.#closed));
      } else {
        this.#client._sendRequest(request, { responseCallback, errorCallback });
      }
    });
  }
  /** @private */
  _cursorClosed(cursor) {
    if (cursor !== this.#cursor) {
      throw new InternalError("Cursor was closed, but it was not associated with the stream");
    }
    this.#cursor = void 0;
    this.#flushQueue();
  }
  #pushToQueue(entry) {
    if (this.#closed !== void 0) {
      entry.errorCallback(new ClosedError("Stream is closed", this.#closed));
    } else if (this.#closing) {
      entry.errorCallback(new ClosedError("Stream is closing", void 0));
    } else {
      this.#queue.push(entry);
      this.#flushQueue();
    }
  }
  #flushQueue() {
    for (; ; ) {
      const entry = this.#queue.first();
      if (entry === void 0 && this.#cursor === void 0 && this.#closing) {
        this.#setClosed(new ClientError("Stream was gracefully closed"));
        break;
      } else if (entry?.type === "request" && this.#cursor === void 0) {
        const { request, responseCallback, errorCallback } = entry;
        this.#queue.shift();
        this.#client._sendRequest(request, { responseCallback, errorCallback });
      } else if (entry?.type === "cursor" && this.#cursor === void 0) {
        const { batch, cursorCallback } = entry;
        this.#queue.shift();
        const cursorId = this.#client._cursorIdAlloc.alloc();
        const cursor = new WsCursor(this.#client, this, cursorId);
        const request = {
          type: "open_cursor",
          streamId: this.#streamId,
          cursorId,
          batch
        };
        const responseCallback = /* @__PURE__ */ __name(() => void 0, "responseCallback");
        const errorCallback = /* @__PURE__ */ __name((e) => cursor._setClosed(e), "errorCallback");
        this.#client._sendRequest(request, { responseCallback, errorCallback });
        this.#cursor = cursor;
        cursorCallback(cursor);
      } else {
        break;
      }
    }
  }
  #setClosed(error) {
    if (this.#closed !== void 0) {
      return;
    }
    this.#closed = error;
    if (this.#cursor !== void 0) {
      this.#cursor._setClosed(error);
    }
    for (; ; ) {
      const entry = this.#queue.shift();
      if (entry !== void 0) {
        entry.errorCallback(error);
      } else {
        break;
      }
    }
    const request = { type: "close_stream", streamId: this.#streamId };
    const responseCallback = /* @__PURE__ */ __name(() => this.#client._streamIdAlloc.free(this.#streamId), "responseCallback");
    const errorCallback = /* @__PURE__ */ __name(() => void 0, "errorCallback");
    this.#client._sendRequest(request, { responseCallback, errorCallback });
  }
  /** Immediately close the stream. */
  close() {
    this.#setClosed(new ClientError("Stream was manually closed"));
  }
  /** Gracefully close the stream. */
  closeGracefully() {
    this.#closing = true;
    this.#flushQueue();
  }
  /** True if the stream is closed or closing. */
  get closed() {
    return this.#closed !== void 0 || this.#closing;
  }
};

// node_modules/@libsql/hrana-client/lib-esm/shared/json_encode.js
function Stmt2(w, msg) {
  if (msg.sql !== void 0) {
    w.string("sql", msg.sql);
  }
  if (msg.sqlId !== void 0) {
    w.number("sql_id", msg.sqlId);
  }
  w.arrayObjects("args", msg.args, Value);
  w.arrayObjects("named_args", msg.namedArgs, NamedArg);
  w.boolean("want_rows", msg.wantRows);
}
__name(Stmt2, "Stmt");
function NamedArg(w, msg) {
  w.string("name", msg.name);
  w.object("value", msg.value, Value);
}
__name(NamedArg, "NamedArg");
function Batch2(w, msg) {
  w.arrayObjects("steps", msg.steps, BatchStep2);
}
__name(Batch2, "Batch");
function BatchStep2(w, msg) {
  if (msg.condition !== void 0) {
    w.object("condition", msg.condition, BatchCond2);
  }
  w.object("stmt", msg.stmt, Stmt2);
}
__name(BatchStep2, "BatchStep");
function BatchCond2(w, msg) {
  w.stringRaw("type", msg.type);
  if (msg.type === "ok" || msg.type === "error") {
    w.number("step", msg.step);
  } else if (msg.type === "not") {
    w.object("cond", msg.cond, BatchCond2);
  } else if (msg.type === "and" || msg.type === "or") {
    w.arrayObjects("conds", msg.conds, BatchCond2);
  } else if (msg.type === "is_autocommit") {
  } else {
    throw impossible(msg, "Impossible type of BatchCond");
  }
}
__name(BatchCond2, "BatchCond");
function Value(w, msg) {
  if (msg === null) {
    w.stringRaw("type", "null");
  } else if (typeof msg === "bigint") {
    w.stringRaw("type", "integer");
    w.stringRaw("value", "" + msg);
  } else if (typeof msg === "number") {
    w.stringRaw("type", "float");
    w.number("value", msg);
  } else if (typeof msg === "string") {
    w.stringRaw("type", "text");
    w.string("value", msg);
  } else if (msg instanceof Uint8Array) {
    w.stringRaw("type", "blob");
    w.stringRaw("base64", gBase64.fromUint8Array(msg));
  } else if (msg === void 0) {
  } else {
    throw impossible(msg, "Impossible type of Value");
  }
}
__name(Value, "Value");

// node_modules/@libsql/hrana-client/lib-esm/ws/json_encode.js
function ClientMsg(w, msg) {
  w.stringRaw("type", msg.type);
  if (msg.type === "hello") {
    if (msg.jwt !== void 0) {
      w.string("jwt", msg.jwt);
    }
  } else if (msg.type === "request") {
    w.number("request_id", msg.requestId);
    w.object("request", msg.request, Request2);
  } else {
    throw impossible(msg, "Impossible type of ClientMsg");
  }
}
__name(ClientMsg, "ClientMsg");
function Request2(w, msg) {
  w.stringRaw("type", msg.type);
  if (msg.type === "open_stream") {
    w.number("stream_id", msg.streamId);
  } else if (msg.type === "close_stream") {
    w.number("stream_id", msg.streamId);
  } else if (msg.type === "execute") {
    w.number("stream_id", msg.streamId);
    w.object("stmt", msg.stmt, Stmt2);
  } else if (msg.type === "batch") {
    w.number("stream_id", msg.streamId);
    w.object("batch", msg.batch, Batch2);
  } else if (msg.type === "open_cursor") {
    w.number("stream_id", msg.streamId);
    w.number("cursor_id", msg.cursorId);
    w.object("batch", msg.batch, Batch2);
  } else if (msg.type === "close_cursor") {
    w.number("cursor_id", msg.cursorId);
  } else if (msg.type === "fetch_cursor") {
    w.number("cursor_id", msg.cursorId);
    w.number("max_count", msg.maxCount);
  } else if (msg.type === "sequence") {
    w.number("stream_id", msg.streamId);
    if (msg.sql !== void 0) {
      w.string("sql", msg.sql);
    }
    if (msg.sqlId !== void 0) {
      w.number("sql_id", msg.sqlId);
    }
  } else if (msg.type === "describe") {
    w.number("stream_id", msg.streamId);
    if (msg.sql !== void 0) {
      w.string("sql", msg.sql);
    }
    if (msg.sqlId !== void 0) {
      w.number("sql_id", msg.sqlId);
    }
  } else if (msg.type === "store_sql") {
    w.number("sql_id", msg.sqlId);
    w.string("sql", msg.sql);
  } else if (msg.type === "close_sql") {
    w.number("sql_id", msg.sqlId);
  } else if (msg.type === "get_autocommit") {
    w.number("stream_id", msg.streamId);
  } else {
    throw impossible(msg, "Impossible type of Request");
  }
}
__name(Request2, "Request");

// node_modules/@libsql/hrana-client/lib-esm/shared/protobuf_encode.js
function Stmt3(w, msg) {
  if (msg.sql !== void 0) {
    w.string(1, msg.sql);
  }
  if (msg.sqlId !== void 0) {
    w.int32(2, msg.sqlId);
  }
  for (const arg of msg.args) {
    w.message(3, arg, Value2);
  }
  for (const arg of msg.namedArgs) {
    w.message(4, arg, NamedArg2);
  }
  w.bool(5, msg.wantRows);
}
__name(Stmt3, "Stmt");
function NamedArg2(w, msg) {
  w.string(1, msg.name);
  w.message(2, msg.value, Value2);
}
__name(NamedArg2, "NamedArg");
function Batch3(w, msg) {
  for (const step of msg.steps) {
    w.message(1, step, BatchStep3);
  }
}
__name(Batch3, "Batch");
function BatchStep3(w, msg) {
  if (msg.condition !== void 0) {
    w.message(1, msg.condition, BatchCond3);
  }
  w.message(2, msg.stmt, Stmt3);
}
__name(BatchStep3, "BatchStep");
function BatchCond3(w, msg) {
  if (msg.type === "ok") {
    w.uint32(1, msg.step);
  } else if (msg.type === "error") {
    w.uint32(2, msg.step);
  } else if (msg.type === "not") {
    w.message(3, msg.cond, BatchCond3);
  } else if (msg.type === "and") {
    w.message(4, msg.conds, BatchCondList);
  } else if (msg.type === "or") {
    w.message(5, msg.conds, BatchCondList);
  } else if (msg.type === "is_autocommit") {
    w.message(6, void 0, Empty);
  } else {
    throw impossible(msg, "Impossible type of BatchCond");
  }
}
__name(BatchCond3, "BatchCond");
function BatchCondList(w, msg) {
  for (const cond of msg) {
    w.message(1, cond, BatchCond3);
  }
}
__name(BatchCondList, "BatchCondList");
function Value2(w, msg) {
  if (msg === null) {
    w.message(1, void 0, Empty);
  } else if (typeof msg === "bigint") {
    w.sint64(2, msg);
  } else if (typeof msg === "number") {
    w.double(3, msg);
  } else if (typeof msg === "string") {
    w.string(4, msg);
  } else if (msg instanceof Uint8Array) {
    w.bytes(5, msg);
  } else if (msg === void 0) {
  } else {
    throw impossible(msg, "Impossible type of Value");
  }
}
__name(Value2, "Value");
function Empty(_w, _msg) {
}
__name(Empty, "Empty");

// node_modules/@libsql/hrana-client/lib-esm/ws/protobuf_encode.js
function ClientMsg2(w, msg) {
  if (msg.type === "hello") {
    w.message(1, msg, HelloMsg);
  } else if (msg.type === "request") {
    w.message(2, msg, RequestMsg);
  } else {
    throw impossible(msg, "Impossible type of ClientMsg");
  }
}
__name(ClientMsg2, "ClientMsg");
function HelloMsg(w, msg) {
  if (msg.jwt !== void 0) {
    w.string(1, msg.jwt);
  }
}
__name(HelloMsg, "HelloMsg");
function RequestMsg(w, msg) {
  w.int32(1, msg.requestId);
  const request = msg.request;
  if (request.type === "open_stream") {
    w.message(2, request, OpenStreamReq);
  } else if (request.type === "close_stream") {
    w.message(3, request, CloseStreamReq);
  } else if (request.type === "execute") {
    w.message(4, request, ExecuteReq);
  } else if (request.type === "batch") {
    w.message(5, request, BatchReq);
  } else if (request.type === "open_cursor") {
    w.message(6, request, OpenCursorReq);
  } else if (request.type === "close_cursor") {
    w.message(7, request, CloseCursorReq);
  } else if (request.type === "fetch_cursor") {
    w.message(8, request, FetchCursorReq);
  } else if (request.type === "sequence") {
    w.message(9, request, SequenceReq);
  } else if (request.type === "describe") {
    w.message(10, request, DescribeReq);
  } else if (request.type === "store_sql") {
    w.message(11, request, StoreSqlReq);
  } else if (request.type === "close_sql") {
    w.message(12, request, CloseSqlReq);
  } else if (request.type === "get_autocommit") {
    w.message(13, request, GetAutocommitReq);
  } else {
    throw impossible(request, "Impossible type of Request");
  }
}
__name(RequestMsg, "RequestMsg");
function OpenStreamReq(w, msg) {
  w.int32(1, msg.streamId);
}
__name(OpenStreamReq, "OpenStreamReq");
function CloseStreamReq(w, msg) {
  w.int32(1, msg.streamId);
}
__name(CloseStreamReq, "CloseStreamReq");
function ExecuteReq(w, msg) {
  w.int32(1, msg.streamId);
  w.message(2, msg.stmt, Stmt3);
}
__name(ExecuteReq, "ExecuteReq");
function BatchReq(w, msg) {
  w.int32(1, msg.streamId);
  w.message(2, msg.batch, Batch3);
}
__name(BatchReq, "BatchReq");
function OpenCursorReq(w, msg) {
  w.int32(1, msg.streamId);
  w.int32(2, msg.cursorId);
  w.message(3, msg.batch, Batch3);
}
__name(OpenCursorReq, "OpenCursorReq");
function CloseCursorReq(w, msg) {
  w.int32(1, msg.cursorId);
}
__name(CloseCursorReq, "CloseCursorReq");
function FetchCursorReq(w, msg) {
  w.int32(1, msg.cursorId);
  w.uint32(2, msg.maxCount);
}
__name(FetchCursorReq, "FetchCursorReq");
function SequenceReq(w, msg) {
  w.int32(1, msg.streamId);
  if (msg.sql !== void 0) {
    w.string(2, msg.sql);
  }
  if (msg.sqlId !== void 0) {
    w.int32(3, msg.sqlId);
  }
}
__name(SequenceReq, "SequenceReq");
function DescribeReq(w, msg) {
  w.int32(1, msg.streamId);
  if (msg.sql !== void 0) {
    w.string(2, msg.sql);
  }
  if (msg.sqlId !== void 0) {
    w.int32(3, msg.sqlId);
  }
}
__name(DescribeReq, "DescribeReq");
function StoreSqlReq(w, msg) {
  w.int32(1, msg.sqlId);
  w.string(2, msg.sql);
}
__name(StoreSqlReq, "StoreSqlReq");
function CloseSqlReq(w, msg) {
  w.int32(1, msg.sqlId);
}
__name(CloseSqlReq, "CloseSqlReq");
function GetAutocommitReq(w, msg) {
  w.int32(1, msg.streamId);
}
__name(GetAutocommitReq, "GetAutocommitReq");

// node_modules/@libsql/hrana-client/lib-esm/shared/json_decode.js
function Error2(obj) {
  const message = string(obj["message"]);
  const code = stringOpt(obj["code"]);
  return { message, code };
}
__name(Error2, "Error");
function StmtResult(obj) {
  const cols = arrayObjectsMap(obj["cols"], Col);
  const rows = array(obj["rows"]).map((rowObj) => arrayObjectsMap(rowObj, Value3));
  const affectedRowCount = number(obj["affected_row_count"]);
  const lastInsertRowidStr = stringOpt(obj["last_insert_rowid"]);
  const lastInsertRowid = lastInsertRowidStr !== void 0 ? BigInt(lastInsertRowidStr) : void 0;
  return { cols, rows, affectedRowCount, lastInsertRowid };
}
__name(StmtResult, "StmtResult");
function Col(obj) {
  const name = stringOpt(obj["name"]);
  const decltype = stringOpt(obj["decltype"]);
  return { name, decltype };
}
__name(Col, "Col");
function BatchResult(obj) {
  const stepResults = /* @__PURE__ */ new Map();
  array(obj["step_results"]).forEach((value, i) => {
    if (value !== null) {
      stepResults.set(i, StmtResult(object(value)));
    }
  });
  const stepErrors = /* @__PURE__ */ new Map();
  array(obj["step_errors"]).forEach((value, i) => {
    if (value !== null) {
      stepErrors.set(i, Error2(object(value)));
    }
  });
  return { stepResults, stepErrors };
}
__name(BatchResult, "BatchResult");
function CursorEntry(obj) {
  const type = string(obj["type"]);
  if (type === "step_begin") {
    const step = number(obj["step"]);
    const cols = arrayObjectsMap(obj["cols"], Col);
    return { type: "step_begin", step, cols };
  } else if (type === "step_end") {
    const affectedRowCount = number(obj["affected_row_count"]);
    const lastInsertRowidStr = stringOpt(obj["last_insert_rowid"]);
    const lastInsertRowid = lastInsertRowidStr !== void 0 ? BigInt(lastInsertRowidStr) : void 0;
    return { type: "step_end", affectedRowCount, lastInsertRowid };
  } else if (type === "step_error") {
    const step = number(obj["step"]);
    const error = Error2(object(obj["error"]));
    return { type: "step_error", step, error };
  } else if (type === "row") {
    const row = arrayObjectsMap(obj["row"], Value3);
    return { type: "row", row };
  } else if (type === "error") {
    const error = Error2(object(obj["error"]));
    return { type: "error", error };
  } else {
    throw new ProtoError("Unexpected type of CursorEntry");
  }
}
__name(CursorEntry, "CursorEntry");
function DescribeResult(obj) {
  const params = arrayObjectsMap(obj["params"], DescribeParam);
  const cols = arrayObjectsMap(obj["cols"], DescribeCol);
  const isExplain = boolean(obj["is_explain"]);
  const isReadonly = boolean(obj["is_readonly"]);
  return { params, cols, isExplain, isReadonly };
}
__name(DescribeResult, "DescribeResult");
function DescribeParam(obj) {
  const name = stringOpt(obj["name"]);
  return { name };
}
__name(DescribeParam, "DescribeParam");
function DescribeCol(obj) {
  const name = string(obj["name"]);
  const decltype = stringOpt(obj["decltype"]);
  return { name, decltype };
}
__name(DescribeCol, "DescribeCol");
function Value3(obj) {
  const type = string(obj["type"]);
  if (type === "null") {
    return null;
  } else if (type === "integer") {
    const value = string(obj["value"]);
    return BigInt(value);
  } else if (type === "float") {
    return number(obj["value"]);
  } else if (type === "text") {
    return string(obj["value"]);
  } else if (type === "blob") {
    return gBase64.toUint8Array(string(obj["base64"]));
  } else {
    throw new ProtoError("Unexpected type of Value");
  }
}
__name(Value3, "Value");

// node_modules/@libsql/hrana-client/lib-esm/ws/json_decode.js
function ServerMsg(obj) {
  const type = string(obj["type"]);
  if (type === "hello_ok") {
    return { type: "hello_ok" };
  } else if (type === "hello_error") {
    const error = Error2(object(obj["error"]));
    return { type: "hello_error", error };
  } else if (type === "response_ok") {
    const requestId = number(obj["request_id"]);
    const response = Response2(object(obj["response"]));
    return { type: "response_ok", requestId, response };
  } else if (type === "response_error") {
    const requestId = number(obj["request_id"]);
    const error = Error2(object(obj["error"]));
    return { type: "response_error", requestId, error };
  } else {
    throw new ProtoError("Unexpected type of ServerMsg");
  }
}
__name(ServerMsg, "ServerMsg");
function Response2(obj) {
  const type = string(obj["type"]);
  if (type === "open_stream") {
    return { type: "open_stream" };
  } else if (type === "close_stream") {
    return { type: "close_stream" };
  } else if (type === "execute") {
    const result = StmtResult(object(obj["result"]));
    return { type: "execute", result };
  } else if (type === "batch") {
    const result = BatchResult(object(obj["result"]));
    return { type: "batch", result };
  } else if (type === "open_cursor") {
    return { type: "open_cursor" };
  } else if (type === "close_cursor") {
    return { type: "close_cursor" };
  } else if (type === "fetch_cursor") {
    const entries = arrayObjectsMap(obj["entries"], CursorEntry);
    const done = boolean(obj["done"]);
    return { type: "fetch_cursor", entries, done };
  } else if (type === "sequence") {
    return { type: "sequence" };
  } else if (type === "describe") {
    const result = DescribeResult(object(obj["result"]));
    return { type: "describe", result };
  } else if (type === "store_sql") {
    return { type: "store_sql" };
  } else if (type === "close_sql") {
    return { type: "close_sql" };
  } else if (type === "get_autocommit") {
    const isAutocommit = boolean(obj["is_autocommit"]);
    return { type: "get_autocommit", isAutocommit };
  } else {
    throw new ProtoError("Unexpected type of Response");
  }
}
__name(Response2, "Response");

// node_modules/@libsql/hrana-client/lib-esm/shared/protobuf_decode.js
var Error3 = {
  default() {
    return { message: "", code: void 0 };
  },
  1(r, msg) {
    msg.message = r.string();
  },
  2(r, msg) {
    msg.code = r.string();
  }
};
var StmtResult2 = {
  default() {
    return {
      cols: [],
      rows: [],
      affectedRowCount: 0,
      lastInsertRowid: void 0
    };
  },
  1(r, msg) {
    msg.cols.push(r.message(Col2));
  },
  2(r, msg) {
    msg.rows.push(r.message(Row));
  },
  3(r, msg) {
    msg.affectedRowCount = Number(r.uint64());
  },
  4(r, msg) {
    msg.lastInsertRowid = r.sint64();
  }
};
var Col2 = {
  default() {
    return { name: void 0, decltype: void 0 };
  },
  1(r, msg) {
    msg.name = r.string();
  },
  2(r, msg) {
    msg.decltype = r.string();
  }
};
var Row = {
  default() {
    return [];
  },
  1(r, msg) {
    msg.push(r.message(Value4));
  }
};
var BatchResult2 = {
  default() {
    return { stepResults: /* @__PURE__ */ new Map(), stepErrors: /* @__PURE__ */ new Map() };
  },
  1(r, msg) {
    const [key, value] = r.message(BatchResultStepResult);
    msg.stepResults.set(key, value);
  },
  2(r, msg) {
    const [key, value] = r.message(BatchResultStepError);
    msg.stepErrors.set(key, value);
  }
};
var BatchResultStepResult = {
  default() {
    return [0, StmtResult2.default()];
  },
  1(r, msg) {
    msg[0] = r.uint32();
  },
  2(r, msg) {
    msg[1] = r.message(StmtResult2);
  }
};
var BatchResultStepError = {
  default() {
    return [0, Error3.default()];
  },
  1(r, msg) {
    msg[0] = r.uint32();
  },
  2(r, msg) {
    msg[1] = r.message(Error3);
  }
};
var CursorEntry2 = {
  default() {
    return { type: "none" };
  },
  1(r) {
    return r.message(StepBeginEntry);
  },
  2(r) {
    return r.message(StepEndEntry);
  },
  3(r) {
    return r.message(StepErrorEntry);
  },
  4(r) {
    return { type: "row", row: r.message(Row) };
  },
  5(r) {
    return { type: "error", error: r.message(Error3) };
  }
};
var StepBeginEntry = {
  default() {
    return { type: "step_begin", step: 0, cols: [] };
  },
  1(r, msg) {
    msg.step = r.uint32();
  },
  2(r, msg) {
    msg.cols.push(r.message(Col2));
  }
};
var StepEndEntry = {
  default() {
    return {
      type: "step_end",
      affectedRowCount: 0,
      lastInsertRowid: void 0
    };
  },
  1(r, msg) {
    msg.affectedRowCount = r.uint32();
  },
  2(r, msg) {
    msg.lastInsertRowid = r.uint64();
  }
};
var StepErrorEntry = {
  default() {
    return {
      type: "step_error",
      step: 0,
      error: Error3.default()
    };
  },
  1(r, msg) {
    msg.step = r.uint32();
  },
  2(r, msg) {
    msg.error = r.message(Error3);
  }
};
var DescribeResult2 = {
  default() {
    return {
      params: [],
      cols: [],
      isExplain: false,
      isReadonly: false
    };
  },
  1(r, msg) {
    msg.params.push(r.message(DescribeParam2));
  },
  2(r, msg) {
    msg.cols.push(r.message(DescribeCol2));
  },
  3(r, msg) {
    msg.isExplain = r.bool();
  },
  4(r, msg) {
    msg.isReadonly = r.bool();
  }
};
var DescribeParam2 = {
  default() {
    return { name: void 0 };
  },
  1(r, msg) {
    msg.name = r.string();
  }
};
var DescribeCol2 = {
  default() {
    return { name: "", decltype: void 0 };
  },
  1(r, msg) {
    msg.name = r.string();
  },
  2(r, msg) {
    msg.decltype = r.string();
  }
};
var Value4 = {
  default() {
    return void 0;
  },
  1(r) {
    return null;
  },
  2(r) {
    return r.sint64();
  },
  3(r) {
    return r.double();
  },
  4(r) {
    return r.string();
  },
  5(r) {
    return r.bytes();
  }
};

// node_modules/@libsql/hrana-client/lib-esm/ws/protobuf_decode.js
var ServerMsg2 = {
  default() {
    return { type: "none" };
  },
  1(r) {
    return { type: "hello_ok" };
  },
  2(r) {
    return r.message(HelloErrorMsg);
  },
  3(r) {
    return r.message(ResponseOkMsg);
  },
  4(r) {
    return r.message(ResponseErrorMsg);
  }
};
var HelloErrorMsg = {
  default() {
    return { type: "hello_error", error: Error3.default() };
  },
  1(r, msg) {
    msg.error = r.message(Error3);
  }
};
var ResponseErrorMsg = {
  default() {
    return { type: "response_error", requestId: 0, error: Error3.default() };
  },
  1(r, msg) {
    msg.requestId = r.int32();
  },
  2(r, msg) {
    msg.error = r.message(Error3);
  }
};
var ResponseOkMsg = {
  default() {
    return {
      type: "response_ok",
      requestId: 0,
      response: { type: "none" }
    };
  },
  1(r, msg) {
    msg.requestId = r.int32();
  },
  2(r, msg) {
    msg.response = { type: "open_stream" };
  },
  3(r, msg) {
    msg.response = { type: "close_stream" };
  },
  4(r, msg) {
    msg.response = r.message(ExecuteResp);
  },
  5(r, msg) {
    msg.response = r.message(BatchResp);
  },
  6(r, msg) {
    msg.response = { type: "open_cursor" };
  },
  7(r, msg) {
    msg.response = { type: "close_cursor" };
  },
  8(r, msg) {
    msg.response = r.message(FetchCursorResp);
  },
  9(r, msg) {
    msg.response = { type: "sequence" };
  },
  10(r, msg) {
    msg.response = r.message(DescribeResp);
  },
  11(r, msg) {
    msg.response = { type: "store_sql" };
  },
  12(r, msg) {
    msg.response = { type: "close_sql" };
  },
  13(r, msg) {
    msg.response = r.message(GetAutocommitResp);
  }
};
var ExecuteResp = {
  default() {
    return { type: "execute", result: StmtResult2.default() };
  },
  1(r, msg) {
    msg.result = r.message(StmtResult2);
  }
};
var BatchResp = {
  default() {
    return { type: "batch", result: BatchResult2.default() };
  },
  1(r, msg) {
    msg.result = r.message(BatchResult2);
  }
};
var FetchCursorResp = {
  default() {
    return { type: "fetch_cursor", entries: [], done: false };
  },
  1(r, msg) {
    msg.entries.push(r.message(CursorEntry2));
  },
  2(r, msg) {
    msg.done = r.bool();
  }
};
var DescribeResp = {
  default() {
    return { type: "describe", result: DescribeResult2.default() };
  },
  1(r, msg) {
    msg.result = r.message(DescribeResult2);
  }
};
var GetAutocommitResp = {
  default() {
    return { type: "get_autocommit", isAutocommit: false };
  },
  1(r, msg) {
    msg.isAutocommit = r.bool();
  }
};

// node_modules/@libsql/hrana-client/lib-esm/ws/client.js
var subprotocolsV2 = /* @__PURE__ */ new Map([
  ["hrana2", { version: 2, encoding: "json" }],
  ["hrana1", { version: 1, encoding: "json" }]
]);
var subprotocolsV3 = /* @__PURE__ */ new Map([
  ["hrana3-protobuf", { version: 3, encoding: "protobuf" }],
  ["hrana3", { version: 3, encoding: "json" }],
  ["hrana2", { version: 2, encoding: "json" }],
  ["hrana1", { version: 1, encoding: "json" }]
]);
var WsClient = class extends Client {
  static {
    __name(this, "WsClient");
  }
  #socket;
  // List of callbacks that we queue until the socket transitions from the CONNECTING to the OPEN state.
  #openCallbacks;
  // Have we already transitioned from CONNECTING to OPEN and fired the callbacks in #openCallbacks?
  #opened;
  // Stores the error that caused us to close the client (and the socket). If we are not closed, this is
  // `undefined`.
  #closed;
  // Have we received a response to our "hello" from the server?
  #recvdHello;
  // Subprotocol negotiated with the server. It is only available after the socket transitions to the OPEN
  // state.
  #subprotocol;
  // Has the `getVersion()` function been called? This is only used to validate that the API is used
  // correctly.
  #getVersionCalled;
  // A map from request id to the responses that we expect to receive from the server.
  #responseMap;
  // An allocator of request ids.
  #requestIdAlloc;
  // An allocator of stream ids.
  /** @private */
  _streamIdAlloc;
  // An allocator of cursor ids.
  /** @private */
  _cursorIdAlloc;
  // An allocator of SQL text ids.
  #sqlIdAlloc;
  /** @private */
  constructor(socket, jwt) {
    super();
    this.#socket = socket;
    this.#openCallbacks = [];
    this.#opened = false;
    this.#closed = void 0;
    this.#recvdHello = false;
    this.#subprotocol = void 0;
    this.#getVersionCalled = false;
    this.#responseMap = /* @__PURE__ */ new Map();
    this.#requestIdAlloc = new IdAlloc();
    this._streamIdAlloc = new IdAlloc();
    this._cursorIdAlloc = new IdAlloc();
    this.#sqlIdAlloc = new IdAlloc();
    this.#socket.binaryType = "arraybuffer";
    this.#socket.addEventListener("open", () => this.#onSocketOpen());
    this.#socket.addEventListener("close", (event) => this.#onSocketClose(event));
    this.#socket.addEventListener("error", (event) => this.#onSocketError(event));
    this.#socket.addEventListener("message", (event) => this.#onSocketMessage(event));
    this.#send({ type: "hello", jwt });
  }
  // Send (or enqueue to send) a message to the server.
  #send(msg) {
    if (this.#closed !== void 0) {
      throw new InternalError("Trying to send a message on a closed client");
    }
    if (this.#opened) {
      this.#sendToSocket(msg);
    } else {
      const openCallback = /* @__PURE__ */ __name(() => this.#sendToSocket(msg), "openCallback");
      const errorCallback = /* @__PURE__ */ __name(() => void 0, "errorCallback");
      this.#openCallbacks.push({ openCallback, errorCallback });
    }
  }
  // The socket transitioned from CONNECTING to OPEN
  #onSocketOpen() {
    const protocol = this.#socket.protocol;
    if (protocol === void 0) {
      this.#setClosed(new ClientError("The `WebSocket.protocol` property is undefined. This most likely means that the WebSocket implementation provided by the environment is broken. If you are using Miniflare 2, please update to Miniflare 3, which fixes this problem."));
      return;
    } else if (protocol === "") {
      this.#subprotocol = { version: 1, encoding: "json" };
    } else {
      this.#subprotocol = subprotocolsV3.get(protocol);
      if (this.#subprotocol === void 0) {
        this.#setClosed(new ProtoError(`Unrecognized WebSocket subprotocol: ${JSON.stringify(protocol)}`));
        return;
      }
    }
    for (const callbacks of this.#openCallbacks) {
      callbacks.openCallback();
    }
    this.#openCallbacks.length = 0;
    this.#opened = true;
  }
  #sendToSocket(msg) {
    const encoding = this.#subprotocol.encoding;
    if (encoding === "json") {
      const jsonMsg = writeJsonObject(msg, ClientMsg);
      this.#socket.send(jsonMsg);
    } else if (encoding === "protobuf") {
      const protobufMsg = writeProtobufMessage(msg, ClientMsg2);
      this.#socket.send(protobufMsg);
    } else {
      throw impossible(encoding, "Impossible encoding");
    }
  }
  /** Get the protocol version negotiated with the server, possibly waiting until the socket is open. */
  getVersion() {
    return new Promise((versionCallback, errorCallback) => {
      this.#getVersionCalled = true;
      if (this.#closed !== void 0) {
        errorCallback(this.#closed);
      } else if (!this.#opened) {
        const openCallback = /* @__PURE__ */ __name(() => versionCallback(this.#subprotocol.version), "openCallback");
        this.#openCallbacks.push({ openCallback, errorCallback });
      } else {
        versionCallback(this.#subprotocol.version);
      }
    });
  }
  // Make sure that the negotiated version is at least `minVersion`.
  /** @private */
  _ensureVersion(minVersion, feature) {
    if (this.#subprotocol === void 0 || !this.#getVersionCalled) {
      throw new ProtocolVersionError(`${feature} is supported only on protocol version ${minVersion} and higher, but the version supported by the WebSocket server is not yet known. Use Client.getVersion() to wait until the version is available.`);
    } else if (this.#subprotocol.version < minVersion) {
      throw new ProtocolVersionError(`${feature} is supported on protocol version ${minVersion} and higher, but the WebSocket server only supports version ${this.#subprotocol.version}`);
    }
  }
  // Send a request to the server and invoke a callback when we get the response.
  /** @private */
  _sendRequest(request, callbacks) {
    if (this.#closed !== void 0) {
      callbacks.errorCallback(new ClosedError("Client is closed", this.#closed));
      return;
    }
    const requestId = this.#requestIdAlloc.alloc();
    this.#responseMap.set(requestId, { ...callbacks, type: request.type });
    this.#send({ type: "request", requestId, request });
  }
  // The socket encountered an error.
  #onSocketError(event) {
    const eventMessage = event.message;
    const message = eventMessage ?? "WebSocket was closed due to an error";
    this.#setClosed(new WebSocketError(message));
  }
  // The socket was closed.
  #onSocketClose(event) {
    let message = `WebSocket was closed with code ${event.code}`;
    if (event.reason) {
      message += `: ${event.reason}`;
    }
    this.#setClosed(new WebSocketError(message));
  }
  // Close the client with the given error.
  #setClosed(error) {
    if (this.#closed !== void 0) {
      return;
    }
    this.#closed = error;
    for (const callbacks of this.#openCallbacks) {
      callbacks.errorCallback(error);
    }
    this.#openCallbacks.length = 0;
    for (const [requestId, responseState] of this.#responseMap.entries()) {
      responseState.errorCallback(error);
      this.#requestIdAlloc.free(requestId);
    }
    this.#responseMap.clear();
    this.#socket.close();
  }
  // We received a message from the socket.
  #onSocketMessage(event) {
    if (this.#closed !== void 0) {
      return;
    }
    try {
      let msg;
      const encoding = this.#subprotocol.encoding;
      if (encoding === "json") {
        if (typeof event.data !== "string") {
          this.#socket.close(3003, "Only text messages are accepted with JSON encoding");
          this.#setClosed(new ProtoError("Received non-text message from server with JSON encoding"));
          return;
        }
        msg = readJsonObject(JSON.parse(event.data), ServerMsg);
      } else if (encoding === "protobuf") {
        if (!(event.data instanceof ArrayBuffer)) {
          this.#socket.close(3003, "Only binary messages are accepted with Protobuf encoding");
          this.#setClosed(new ProtoError("Received non-binary message from server with Protobuf encoding"));
          return;
        }
        msg = readProtobufMessage(new Uint8Array(event.data), ServerMsg2);
      } else {
        throw impossible(encoding, "Impossible encoding");
      }
      this.#handleMsg(msg);
    } catch (e) {
      this.#socket.close(3007, "Could not handle message");
      this.#setClosed(e);
    }
  }
  // Handle a message from the server.
  #handleMsg(msg) {
    if (msg.type === "none") {
      throw new ProtoError("Received an unrecognized ServerMsg");
    } else if (msg.type === "hello_ok" || msg.type === "hello_error") {
      if (this.#recvdHello) {
        throw new ProtoError("Received a duplicated hello response");
      }
      this.#recvdHello = true;
      if (msg.type === "hello_error") {
        throw errorFromProto(msg.error);
      }
      return;
    } else if (!this.#recvdHello) {
      throw new ProtoError("Received a non-hello message before a hello response");
    }
    if (msg.type === "response_ok") {
      const requestId = msg.requestId;
      const responseState = this.#responseMap.get(requestId);
      this.#responseMap.delete(requestId);
      if (responseState === void 0) {
        throw new ProtoError("Received unexpected OK response");
      }
      this.#requestIdAlloc.free(requestId);
      try {
        if (responseState.type !== msg.response.type) {
          console.dir({ responseState, msg });
          throw new ProtoError("Received unexpected type of response");
        }
        responseState.responseCallback(msg.response);
      } catch (e) {
        responseState.errorCallback(e);
        throw e;
      }
    } else if (msg.type === "response_error") {
      const requestId = msg.requestId;
      const responseState = this.#responseMap.get(requestId);
      this.#responseMap.delete(requestId);
      if (responseState === void 0) {
        throw new ProtoError("Received unexpected error response");
      }
      this.#requestIdAlloc.free(requestId);
      responseState.errorCallback(errorFromProto(msg.error));
    } else {
      throw impossible(msg, "Impossible ServerMsg type");
    }
  }
  /** Open a {@link WsStream}, a stream for executing SQL statements. */
  openStream() {
    return WsStream.open(this);
  }
  /** Cache a SQL text on the server. This requires protocol version 2 or higher. */
  storeSql(sql) {
    this._ensureVersion(2, "storeSql()");
    const sqlId = this.#sqlIdAlloc.alloc();
    const sqlObj = new Sql(this, sqlId);
    const responseCallback = /* @__PURE__ */ __name(() => void 0, "responseCallback");
    const errorCallback = /* @__PURE__ */ __name((e) => sqlObj._setClosed(e), "errorCallback");
    const request = { type: "store_sql", sqlId, sql };
    this._sendRequest(request, { responseCallback, errorCallback });
    return sqlObj;
  }
  /** @private */
  _closeSql(sqlId) {
    if (this.#closed !== void 0) {
      return;
    }
    const responseCallback = /* @__PURE__ */ __name(() => this.#sqlIdAlloc.free(sqlId), "responseCallback");
    const errorCallback = /* @__PURE__ */ __name((e) => this.#setClosed(e), "errorCallback");
    const request = { type: "close_sql", sqlId };
    this._sendRequest(request, { responseCallback, errorCallback });
  }
  /** Close the client and the WebSocket. */
  close() {
    this.#setClosed(new ClientError("Client was manually closed"));
  }
  /** True if the client is closed. */
  get closed() {
    return this.#closed !== void 0;
  }
};

// node_modules/@libsql/hrana-client/lib-esm/queue_microtask.js
var _queueMicrotask;
if (typeof queueMicrotask !== "undefined") {
  _queueMicrotask = queueMicrotask;
} else {
  const resolved = Promise.resolve();
  _queueMicrotask = /* @__PURE__ */ __name((callback) => {
    resolved.then(callback);
  }, "_queueMicrotask");
}

// node_modules/@libsql/hrana-client/lib-esm/byte_queue.js
var ByteQueue = class {
  static {
    __name(this, "ByteQueue");
  }
  #array;
  #shiftPos;
  #pushPos;
  constructor(initialCap) {
    this.#array = new Uint8Array(new ArrayBuffer(initialCap));
    this.#shiftPos = 0;
    this.#pushPos = 0;
  }
  get length() {
    return this.#pushPos - this.#shiftPos;
  }
  data() {
    return this.#array.slice(this.#shiftPos, this.#pushPos);
  }
  push(chunk) {
    this.#ensurePush(chunk.byteLength);
    this.#array.set(chunk, this.#pushPos);
    this.#pushPos += chunk.byteLength;
  }
  #ensurePush(pushLength) {
    if (this.#pushPos + pushLength <= this.#array.byteLength) {
      return;
    }
    const filledLength = this.#pushPos - this.#shiftPos;
    if (filledLength + pushLength <= this.#array.byteLength && 2 * this.#pushPos >= this.#array.byteLength) {
      this.#array.copyWithin(0, this.#shiftPos, this.#pushPos);
    } else {
      let newCap = this.#array.byteLength;
      do {
        newCap *= 2;
      } while (filledLength + pushLength > newCap);
      const newArray = new Uint8Array(new ArrayBuffer(newCap));
      newArray.set(this.#array.slice(this.#shiftPos, this.#pushPos), 0);
      this.#array = newArray;
    }
    this.#pushPos = filledLength;
    this.#shiftPos = 0;
  }
  shift(length) {
    this.#shiftPos += length;
  }
};

// node_modules/@libsql/hrana-client/lib-esm/http/json_decode.js
function PipelineRespBody(obj) {
  const baton = stringOpt(obj["baton"]);
  const baseUrl = stringOpt(obj["base_url"]);
  const results = arrayObjectsMap(obj["results"], StreamResult);
  return { baton, baseUrl, results };
}
__name(PipelineRespBody, "PipelineRespBody");
function StreamResult(obj) {
  const type = string(obj["type"]);
  if (type === "ok") {
    const response = StreamResponse(object(obj["response"]));
    return { type: "ok", response };
  } else if (type === "error") {
    const error = Error2(object(obj["error"]));
    return { type: "error", error };
  } else {
    throw new ProtoError("Unexpected type of StreamResult");
  }
}
__name(StreamResult, "StreamResult");
function StreamResponse(obj) {
  const type = string(obj["type"]);
  if (type === "close") {
    return { type: "close" };
  } else if (type === "execute") {
    const result = StmtResult(object(obj["result"]));
    return { type: "execute", result };
  } else if (type === "batch") {
    const result = BatchResult(object(obj["result"]));
    return { type: "batch", result };
  } else if (type === "sequence") {
    return { type: "sequence" };
  } else if (type === "describe") {
    const result = DescribeResult(object(obj["result"]));
    return { type: "describe", result };
  } else if (type === "store_sql") {
    return { type: "store_sql" };
  } else if (type === "close_sql") {
    return { type: "close_sql" };
  } else if (type === "get_autocommit") {
    const isAutocommit = boolean(obj["is_autocommit"]);
    return { type: "get_autocommit", isAutocommit };
  } else {
    throw new ProtoError("Unexpected type of StreamResponse");
  }
}
__name(StreamResponse, "StreamResponse");
function CursorRespBody(obj) {
  const baton = stringOpt(obj["baton"]);
  const baseUrl = stringOpt(obj["base_url"]);
  return { baton, baseUrl };
}
__name(CursorRespBody, "CursorRespBody");

// node_modules/@libsql/hrana-client/lib-esm/http/protobuf_decode.js
var PipelineRespBody2 = {
  default() {
    return { baton: void 0, baseUrl: void 0, results: [] };
  },
  1(r, msg) {
    msg.baton = r.string();
  },
  2(r, msg) {
    msg.baseUrl = r.string();
  },
  3(r, msg) {
    msg.results.push(r.message(StreamResult2));
  }
};
var StreamResult2 = {
  default() {
    return { type: "none" };
  },
  1(r) {
    return { type: "ok", response: r.message(StreamResponse2) };
  },
  2(r) {
    return { type: "error", error: r.message(Error3) };
  }
};
var StreamResponse2 = {
  default() {
    return { type: "none" };
  },
  1(r) {
    return { type: "close" };
  },
  2(r) {
    return r.message(ExecuteStreamResp);
  },
  3(r) {
    return r.message(BatchStreamResp);
  },
  4(r) {
    return { type: "sequence" };
  },
  5(r) {
    return r.message(DescribeStreamResp);
  },
  6(r) {
    return { type: "store_sql" };
  },
  7(r) {
    return { type: "close_sql" };
  },
  8(r) {
    return r.message(GetAutocommitStreamResp);
  }
};
var ExecuteStreamResp = {
  default() {
    return { type: "execute", result: StmtResult2.default() };
  },
  1(r, msg) {
    msg.result = r.message(StmtResult2);
  }
};
var BatchStreamResp = {
  default() {
    return { type: "batch", result: BatchResult2.default() };
  },
  1(r, msg) {
    msg.result = r.message(BatchResult2);
  }
};
var DescribeStreamResp = {
  default() {
    return { type: "describe", result: DescribeResult2.default() };
  },
  1(r, msg) {
    msg.result = r.message(DescribeResult2);
  }
};
var GetAutocommitStreamResp = {
  default() {
    return { type: "get_autocommit", isAutocommit: false };
  },
  1(r, msg) {
    msg.isAutocommit = r.bool();
  }
};
var CursorRespBody2 = {
  default() {
    return { baton: void 0, baseUrl: void 0 };
  },
  1(r, msg) {
    msg.baton = r.string();
  },
  2(r, msg) {
    msg.baseUrl = r.string();
  }
};

// node_modules/@libsql/hrana-client/lib-esm/http/cursor.js
var HttpCursor = class extends Cursor {
  static {
    __name(this, "HttpCursor");
  }
  #stream;
  #encoding;
  #reader;
  #queue;
  #closed;
  #done;
  /** @private */
  constructor(stream, encoding) {
    super();
    this.#stream = stream;
    this.#encoding = encoding;
    this.#reader = void 0;
    this.#queue = new ByteQueue(16 * 1024);
    this.#closed = void 0;
    this.#done = false;
  }
  async open(response) {
    if (response.body === null) {
      throw new ProtoError("No response body for cursor request");
    }
    this.#reader = response.body[Symbol.asyncIterator]();
    const respBody = await this.#nextItem(CursorRespBody, CursorRespBody2);
    if (respBody === void 0) {
      throw new ProtoError("Empty response to cursor request");
    }
    return respBody;
  }
  /** Fetch the next entry from the cursor. */
  next() {
    return this.#nextItem(CursorEntry, CursorEntry2);
  }
  /** Close the cursor. */
  close() {
    this._setClosed(new ClientError("Cursor was manually closed"));
  }
  /** @private */
  _setClosed(error) {
    if (this.#closed !== void 0) {
      return;
    }
    this.#closed = error;
    this.#stream._cursorClosed(this);
    if (this.#reader !== void 0) {
      this.#reader.return();
    }
  }
  /** True if the cursor is closed. */
  get closed() {
    return this.#closed !== void 0;
  }
  async #nextItem(jsonFun, protobufDef) {
    for (; ; ) {
      if (this.#done) {
        return void 0;
      } else if (this.#closed !== void 0) {
        throw new ClosedError("Cursor is closed", this.#closed);
      }
      if (this.#encoding === "json") {
        const jsonData = this.#parseItemJson();
        if (jsonData !== void 0) {
          const jsonText = new TextDecoder().decode(jsonData);
          const jsonValue = JSON.parse(jsonText);
          return readJsonObject(jsonValue, jsonFun);
        }
      } else if (this.#encoding === "protobuf") {
        const protobufData = this.#parseItemProtobuf();
        if (protobufData !== void 0) {
          return readProtobufMessage(protobufData, protobufDef);
        }
      } else {
        throw impossible(this.#encoding, "Impossible encoding");
      }
      if (this.#reader === void 0) {
        throw new InternalError("Attempted to read from HTTP cursor before it was opened");
      }
      const { value, done } = await this.#reader.next();
      if (done && this.#queue.length === 0) {
        this.#done = true;
      } else if (done) {
        throw new ProtoError("Unexpected end of cursor stream");
      } else {
        this.#queue.push(value);
      }
    }
  }
  #parseItemJson() {
    const data = this.#queue.data();
    const newlineByte = 10;
    const newlinePos = data.indexOf(newlineByte);
    if (newlinePos < 0) {
      return void 0;
    }
    const jsonData = data.slice(0, newlinePos);
    this.#queue.shift(newlinePos + 1);
    return jsonData;
  }
  #parseItemProtobuf() {
    const data = this.#queue.data();
    let varintValue = 0;
    let varintLength = 0;
    for (; ; ) {
      if (varintLength >= data.byteLength) {
        return void 0;
      }
      const byte = data[varintLength];
      varintValue |= (byte & 127) << 7 * varintLength;
      varintLength += 1;
      if (!(byte & 128)) {
        break;
      }
    }
    if (data.byteLength < varintLength + varintValue) {
      return void 0;
    }
    const protobufData = data.slice(varintLength, varintLength + varintValue);
    this.#queue.shift(varintLength + varintValue);
    return protobufData;
  }
};

// node_modules/@libsql/hrana-client/lib-esm/http/json_encode.js
function PipelineReqBody(w, msg) {
  if (msg.baton !== void 0) {
    w.string("baton", msg.baton);
  }
  w.arrayObjects("requests", msg.requests, StreamRequest);
}
__name(PipelineReqBody, "PipelineReqBody");
function StreamRequest(w, msg) {
  w.stringRaw("type", msg.type);
  if (msg.type === "close") {
  } else if (msg.type === "execute") {
    w.object("stmt", msg.stmt, Stmt2);
  } else if (msg.type === "batch") {
    w.object("batch", msg.batch, Batch2);
  } else if (msg.type === "sequence") {
    if (msg.sql !== void 0) {
      w.string("sql", msg.sql);
    }
    if (msg.sqlId !== void 0) {
      w.number("sql_id", msg.sqlId);
    }
  } else if (msg.type === "describe") {
    if (msg.sql !== void 0) {
      w.string("sql", msg.sql);
    }
    if (msg.sqlId !== void 0) {
      w.number("sql_id", msg.sqlId);
    }
  } else if (msg.type === "store_sql") {
    w.number("sql_id", msg.sqlId);
    w.string("sql", msg.sql);
  } else if (msg.type === "close_sql") {
    w.number("sql_id", msg.sqlId);
  } else if (msg.type === "get_autocommit") {
  } else {
    throw impossible(msg, "Impossible type of StreamRequest");
  }
}
__name(StreamRequest, "StreamRequest");
function CursorReqBody(w, msg) {
  if (msg.baton !== void 0) {
    w.string("baton", msg.baton);
  }
  w.object("batch", msg.batch, Batch2);
}
__name(CursorReqBody, "CursorReqBody");

// node_modules/@libsql/hrana-client/lib-esm/http/protobuf_encode.js
function PipelineReqBody2(w, msg) {
  if (msg.baton !== void 0) {
    w.string(1, msg.baton);
  }
  for (const req of msg.requests) {
    w.message(2, req, StreamRequest2);
  }
}
__name(PipelineReqBody2, "PipelineReqBody");
function StreamRequest2(w, msg) {
  if (msg.type === "close") {
    w.message(1, msg, CloseStreamReq2);
  } else if (msg.type === "execute") {
    w.message(2, msg, ExecuteStreamReq);
  } else if (msg.type === "batch") {
    w.message(3, msg, BatchStreamReq);
  } else if (msg.type === "sequence") {
    w.message(4, msg, SequenceStreamReq);
  } else if (msg.type === "describe") {
    w.message(5, msg, DescribeStreamReq);
  } else if (msg.type === "store_sql") {
    w.message(6, msg, StoreSqlStreamReq);
  } else if (msg.type === "close_sql") {
    w.message(7, msg, CloseSqlStreamReq);
  } else if (msg.type === "get_autocommit") {
    w.message(8, msg, GetAutocommitStreamReq);
  } else {
    throw impossible(msg, "Impossible type of StreamRequest");
  }
}
__name(StreamRequest2, "StreamRequest");
function CloseStreamReq2(_w, _msg) {
}
__name(CloseStreamReq2, "CloseStreamReq");
function ExecuteStreamReq(w, msg) {
  w.message(1, msg.stmt, Stmt3);
}
__name(ExecuteStreamReq, "ExecuteStreamReq");
function BatchStreamReq(w, msg) {
  w.message(1, msg.batch, Batch3);
}
__name(BatchStreamReq, "BatchStreamReq");
function SequenceStreamReq(w, msg) {
  if (msg.sql !== void 0) {
    w.string(1, msg.sql);
  }
  if (msg.sqlId !== void 0) {
    w.int32(2, msg.sqlId);
  }
}
__name(SequenceStreamReq, "SequenceStreamReq");
function DescribeStreamReq(w, msg) {
  if (msg.sql !== void 0) {
    w.string(1, msg.sql);
  }
  if (msg.sqlId !== void 0) {
    w.int32(2, msg.sqlId);
  }
}
__name(DescribeStreamReq, "DescribeStreamReq");
function StoreSqlStreamReq(w, msg) {
  w.int32(1, msg.sqlId);
  w.string(2, msg.sql);
}
__name(StoreSqlStreamReq, "StoreSqlStreamReq");
function CloseSqlStreamReq(w, msg) {
  w.int32(1, msg.sqlId);
}
__name(CloseSqlStreamReq, "CloseSqlStreamReq");
function GetAutocommitStreamReq(_w, _msg) {
}
__name(GetAutocommitStreamReq, "GetAutocommitStreamReq");
function CursorReqBody2(w, msg) {
  if (msg.baton !== void 0) {
    w.string(1, msg.baton);
  }
  w.message(2, msg.batch, Batch3);
}
__name(CursorReqBody2, "CursorReqBody");

// node_modules/@libsql/hrana-client/lib-esm/http/stream.js
var HttpStream = class extends Stream {
  static {
    __name(this, "HttpStream");
  }
  #client;
  #baseUrl;
  #jwt;
  #fetch;
  #remoteEncryptionKey;
  #baton;
  #queue;
  #flushing;
  #cursor;
  #closing;
  #closeQueued;
  #closed;
  #sqlIdAlloc;
  /** @private */
  constructor(client, baseUrl, jwt, customFetch, remoteEncryptionKey) {
    super(client.intMode);
    this.#client = client;
    this.#baseUrl = baseUrl.toString();
    this.#jwt = jwt;
    this.#fetch = customFetch;
    this.#remoteEncryptionKey = remoteEncryptionKey;
    this.#baton = void 0;
    this.#queue = new Queue();
    this.#flushing = false;
    this.#closing = false;
    this.#closeQueued = false;
    this.#closed = void 0;
    this.#sqlIdAlloc = new IdAlloc();
  }
  /** Get the {@link HttpClient} object that this stream belongs to. */
  client() {
    return this.#client;
  }
  /** @private */
  _sqlOwner() {
    return this;
  }
  /** Cache a SQL text on the server. */
  storeSql(sql) {
    const sqlId = this.#sqlIdAlloc.alloc();
    this.#sendStreamRequest({ type: "store_sql", sqlId, sql }).then(() => void 0, (error) => this._setClosed(error));
    return new Sql(this, sqlId);
  }
  /** @private */
  _closeSql(sqlId) {
    if (this.#closed !== void 0) {
      return;
    }
    this.#sendStreamRequest({ type: "close_sql", sqlId }).then(() => this.#sqlIdAlloc.free(sqlId), (error) => this._setClosed(error));
  }
  /** @private */
  _execute(stmt) {
    return this.#sendStreamRequest({ type: "execute", stmt }).then((response) => {
      return response.result;
    });
  }
  /** @private */
  _batch(batch) {
    return this.#sendStreamRequest({ type: "batch", batch }).then((response) => {
      return response.result;
    });
  }
  /** @private */
  _describe(protoSql) {
    return this.#sendStreamRequest({
      type: "describe",
      sql: protoSql.sql,
      sqlId: protoSql.sqlId
    }).then((response) => {
      return response.result;
    });
  }
  /** @private */
  _sequence(protoSql) {
    return this.#sendStreamRequest({
      type: "sequence",
      sql: protoSql.sql,
      sqlId: protoSql.sqlId
    }).then((_response) => {
      return void 0;
    });
  }
  /** Check whether the SQL connection underlying this stream is in autocommit state (i.e., outside of an
   * explicit transaction). This requires protocol version 3 or higher.
   */
  getAutocommit() {
    this.#client._ensureVersion(3, "getAutocommit()");
    return this.#sendStreamRequest({
      type: "get_autocommit"
    }).then((response) => {
      return response.isAutocommit;
    });
  }
  #sendStreamRequest(request) {
    return new Promise((responseCallback, errorCallback) => {
      this.#pushToQueue({ type: "pipeline", request, responseCallback, errorCallback });
    });
  }
  /** @private */
  _openCursor(batch) {
    return new Promise((cursorCallback, errorCallback) => {
      this.#pushToQueue({ type: "cursor", batch, cursorCallback, errorCallback });
    });
  }
  /** @private */
  _cursorClosed(cursor) {
    if (cursor !== this.#cursor) {
      throw new InternalError("Cursor was closed, but it was not associated with the stream");
    }
    this.#cursor = void 0;
    _queueMicrotask(() => this.#flushQueue());
  }
  /** Immediately close the stream. */
  close() {
    this._setClosed(new ClientError("Stream was manually closed"));
  }
  /** Gracefully close the stream. */
  closeGracefully() {
    this.#closing = true;
    _queueMicrotask(() => this.#flushQueue());
  }
  /** True if the stream is closed. */
  get closed() {
    return this.#closed !== void 0 || this.#closing;
  }
  /** @private */
  _setClosed(error) {
    if (this.#closed !== void 0) {
      return;
    }
    this.#closed = error;
    if (this.#cursor !== void 0) {
      this.#cursor._setClosed(error);
    }
    this.#client._streamClosed(this);
    for (; ; ) {
      const entry = this.#queue.shift();
      if (entry !== void 0) {
        entry.errorCallback(error);
      } else {
        break;
      }
    }
    if ((this.#baton !== void 0 || this.#flushing) && !this.#closeQueued) {
      this.#queue.push({
        type: "pipeline",
        request: { type: "close" },
        responseCallback: /* @__PURE__ */ __name(() => void 0, "responseCallback"),
        errorCallback: /* @__PURE__ */ __name(() => void 0, "errorCallback")
      });
      this.#closeQueued = true;
      _queueMicrotask(() => this.#flushQueue());
    }
  }
  #pushToQueue(entry) {
    if (this.#closed !== void 0) {
      throw new ClosedError("Stream is closed", this.#closed);
    } else if (this.#closing) {
      throw new ClosedError("Stream is closing", void 0);
    } else {
      this.#queue.push(entry);
      _queueMicrotask(() => this.#flushQueue());
    }
  }
  #flushQueue() {
    if (this.#flushing || this.#cursor !== void 0) {
      return;
    }
    if (this.#closing && this.#queue.length === 0) {
      this._setClosed(new ClientError("Stream was gracefully closed"));
      return;
    }
    const endpoint = this.#client._endpoint;
    if (endpoint === void 0) {
      this.#client._endpointPromise.then(() => this.#flushQueue(), (error) => this._setClosed(error));
      return;
    }
    const firstEntry = this.#queue.shift();
    if (firstEntry === void 0) {
      return;
    } else if (firstEntry.type === "pipeline") {
      const pipeline = [firstEntry];
      for (; ; ) {
        const entry = this.#queue.first();
        if (entry !== void 0 && entry.type === "pipeline") {
          pipeline.push(entry);
          this.#queue.shift();
        } else if (entry === void 0 && this.#closing && !this.#closeQueued) {
          pipeline.push({
            type: "pipeline",
            request: { type: "close" },
            responseCallback: /* @__PURE__ */ __name(() => void 0, "responseCallback"),
            errorCallback: /* @__PURE__ */ __name(() => void 0, "errorCallback")
          });
          this.#closeQueued = true;
          break;
        } else {
          break;
        }
      }
      this.#flushPipeline(endpoint, pipeline);
    } else if (firstEntry.type === "cursor") {
      this.#flushCursor(endpoint, firstEntry);
    } else {
      throw impossible(firstEntry, "Impossible type of QueueEntry");
    }
  }
  #flushPipeline(endpoint, pipeline) {
    this.#flush(() => this.#createPipelineRequest(pipeline, endpoint), (resp) => decodePipelineResponse(resp, endpoint.encoding), (respBody) => respBody.baton, (respBody) => respBody.baseUrl, (respBody) => handlePipelineResponse(pipeline, respBody), (error) => pipeline.forEach((entry) => entry.errorCallback(error)));
  }
  #flushCursor(endpoint, entry) {
    const cursor = new HttpCursor(this, endpoint.encoding);
    this.#cursor = cursor;
    this.#flush(() => this.#createCursorRequest(entry, endpoint), (resp) => cursor.open(resp), (respBody) => respBody.baton, (respBody) => respBody.baseUrl, (_respBody) => entry.cursorCallback(cursor), (error) => entry.errorCallback(error));
  }
  #flush(createRequest, decodeResponse, getBaton, getBaseUrl, handleResponse, handleError) {
    let promise;
    try {
      const request = createRequest();
      const fetch2 = this.#fetch;
      promise = fetch2(request);
    } catch (error) {
      promise = Promise.reject(error);
    }
    this.#flushing = true;
    promise.then((resp) => {
      if (!resp.ok) {
        return errorFromResponse(resp).then((error) => {
          throw error;
        });
      }
      return decodeResponse(resp);
    }).then((r) => {
      this.#baton = getBaton(r);
      this.#baseUrl = getBaseUrl(r) ?? this.#baseUrl;
      handleResponse(r);
    }).catch((error) => {
      this._setClosed(error);
      handleError(error);
    }).finally(() => {
      this.#flushing = false;
      this.#flushQueue();
    });
  }
  #createPipelineRequest(pipeline, endpoint) {
    return this.#createRequest(new URL(endpoint.pipelinePath, this.#baseUrl), {
      baton: this.#baton,
      requests: pipeline.map((entry) => entry.request)
    }, endpoint.encoding, PipelineReqBody, PipelineReqBody2);
  }
  #createCursorRequest(entry, endpoint) {
    if (endpoint.cursorPath === void 0) {
      throw new ProtocolVersionError(`Cursors are supported only on protocol version 3 and higher, but the HTTP server only supports version ${endpoint.version}.`);
    }
    return this.#createRequest(new URL(endpoint.cursorPath, this.#baseUrl), {
      baton: this.#baton,
      batch: entry.batch
    }, endpoint.encoding, CursorReqBody, CursorReqBody2);
  }
  #createRequest(url, reqBody, encoding, jsonFun, protobufFun) {
    let bodyData;
    let contentType;
    if (encoding === "json") {
      bodyData = writeJsonObject(reqBody, jsonFun);
      contentType = "application/json";
    } else if (encoding === "protobuf") {
      bodyData = writeProtobufMessage(reqBody, protobufFun);
      contentType = "application/x-protobuf";
    } else {
      throw impossible(encoding, "Impossible encoding");
    }
    const headers = new Headers();
    headers.set("content-type", contentType);
    if (this.#jwt !== void 0) {
      headers.set("authorization", `Bearer ${this.#jwt}`);
    }
    if (this.#remoteEncryptionKey !== void 0) {
      headers.set("x-turso-encryption-key", this.#remoteEncryptionKey);
    }
    return new Request(url.toString(), { method: "POST", headers, body: bodyData });
  }
};
function handlePipelineResponse(pipeline, respBody) {
  if (respBody.results.length !== pipeline.length) {
    throw new ProtoError("Server returned unexpected number of pipeline results");
  }
  for (let i = 0; i < pipeline.length; ++i) {
    const result = respBody.results[i];
    const entry = pipeline[i];
    if (result.type === "ok") {
      if (result.response.type !== entry.request.type) {
        throw new ProtoError("Received unexpected type of response");
      }
      entry.responseCallback(result.response);
    } else if (result.type === "error") {
      entry.errorCallback(errorFromProto(result.error));
    } else if (result.type === "none") {
      throw new ProtoError("Received unrecognized type of StreamResult");
    } else {
      throw impossible(result, "Received impossible type of StreamResult");
    }
  }
}
__name(handlePipelineResponse, "handlePipelineResponse");
async function decodePipelineResponse(resp, encoding) {
  if (encoding === "json") {
    const respJson = await resp.json();
    return readJsonObject(respJson, PipelineRespBody);
  }
  if (encoding === "protobuf") {
    const respData = await resp.arrayBuffer();
    return readProtobufMessage(new Uint8Array(respData), PipelineRespBody2);
  }
  await resp.body?.cancel();
  throw impossible(encoding, "Impossible encoding");
}
__name(decodePipelineResponse, "decodePipelineResponse");
async function errorFromResponse(resp) {
  const respType = resp.headers.get("content-type") ?? "text/plain";
  let message = `Server returned HTTP status ${resp.status}`;
  if (respType === "application/json") {
    const respBody = await resp.json();
    if ("message" in respBody) {
      return errorFromProto(respBody);
    }
    return new HttpServerError(message, resp.status);
  }
  if (respType === "text/plain") {
    const respBody = (await resp.text()).trim();
    if (respBody !== "") {
      message += `: ${respBody}`;
    }
    return new HttpServerError(message, resp.status);
  }
  await resp.body?.cancel();
  return new HttpServerError(message, resp.status);
}
__name(errorFromResponse, "errorFromResponse");

// node_modules/@libsql/hrana-client/lib-esm/http/client.js
var checkEndpoints = [
  {
    versionPath: "v3-protobuf",
    pipelinePath: "v3-protobuf/pipeline",
    cursorPath: "v3-protobuf/cursor",
    version: 3,
    encoding: "protobuf"
  }
  /*
  {
      versionPath: "v3",
      pipelinePath: "v3/pipeline",
      cursorPath: "v3/cursor",
      version: 3,
      encoding: "json",
  },
  */
];
var fallbackEndpoint = {
  versionPath: "v2",
  pipelinePath: "v2/pipeline",
  cursorPath: void 0,
  version: 2,
  encoding: "json"
};
var HttpClient = class extends Client {
  static {
    __name(this, "HttpClient");
  }
  #url;
  #jwt;
  #fetch;
  #remoteEncryptionKey;
  #closed;
  #streams;
  /** @private */
  _endpointPromise;
  /** @private */
  _endpoint;
  /** @private */
  constructor(url, jwt, customFetch, remoteEncryptionKey, protocolVersion = 2) {
    super();
    this.#url = url;
    this.#jwt = jwt;
    this.#fetch = customFetch ?? globalThis.fetch;
    this.#remoteEncryptionKey = remoteEncryptionKey;
    this.#closed = void 0;
    this.#streams = /* @__PURE__ */ new Set();
    if (protocolVersion == 3) {
      this._endpointPromise = findEndpoint(this.#fetch, this.#url);
      this._endpointPromise.then((endpoint) => this._endpoint = endpoint, (error) => this.#setClosed(error));
    } else {
      this._endpointPromise = Promise.resolve(fallbackEndpoint);
      this._endpointPromise.then((endpoint) => this._endpoint = endpoint, (error) => this.#setClosed(error));
    }
  }
  /** Get the protocol version supported by the server. */
  async getVersion() {
    if (this._endpoint !== void 0) {
      return this._endpoint.version;
    }
    return (await this._endpointPromise).version;
  }
  // Make sure that the negotiated version is at least `minVersion`.
  /** @private */
  _ensureVersion(minVersion, feature) {
    if (minVersion <= fallbackEndpoint.version) {
      return;
    } else if (this._endpoint === void 0) {
      throw new ProtocolVersionError(`${feature} is supported only on protocol version ${minVersion} and higher, but the version supported by the HTTP server is not yet known. Use Client.getVersion() to wait until the version is available.`);
    } else if (this._endpoint.version < minVersion) {
      throw new ProtocolVersionError(`${feature} is supported only on protocol version ${minVersion} and higher, but the HTTP server only supports version ${this._endpoint.version}.`);
    }
  }
  /** Open a {@link HttpStream}, a stream for executing SQL statements. */
  openStream() {
    if (this.#closed !== void 0) {
      throw new ClosedError("Client is closed", this.#closed);
    }
    const stream = new HttpStream(this, this.#url, this.#jwt, this.#fetch, this.#remoteEncryptionKey);
    this.#streams.add(stream);
    return stream;
  }
  /** @private */
  _streamClosed(stream) {
    this.#streams.delete(stream);
  }
  /** Close the client and all its streams. */
  close() {
    this.#setClosed(new ClientError("Client was manually closed"));
  }
  /** True if the client is closed. */
  get closed() {
    return this.#closed !== void 0;
  }
  #setClosed(error) {
    if (this.#closed !== void 0) {
      return;
    }
    this.#closed = error;
    for (const stream of Array.from(this.#streams)) {
      stream._setClosed(new ClosedError("Client was closed", error));
    }
  }
};
async function findEndpoint(customFetch, clientUrl) {
  const fetch2 = customFetch;
  for (const endpoint of checkEndpoints) {
    const url = new URL(endpoint.versionPath, clientUrl);
    const request = new Request(url.toString(), { method: "GET" });
    const response = await fetch2(request);
    await response.arrayBuffer();
    if (response.ok) {
      return endpoint;
    }
  }
  return fallbackEndpoint;
}
__name(findEndpoint, "findEndpoint");

// node_modules/@libsql/hrana-client/lib-esm/index.js
function openWs(url, jwt, protocolVersion = 2) {
  if (typeof _WebSocket === "undefined") {
    throw new WebSocketUnsupportedError("WebSockets are not supported in this environment");
  }
  var subprotocols = void 0;
  if (protocolVersion == 3) {
    subprotocols = Array.from(subprotocolsV3.keys());
  } else {
    subprotocols = Array.from(subprotocolsV2.keys());
  }
  const socket = new _WebSocket(url, subprotocols);
  return new WsClient(socket, jwt);
}
__name(openWs, "openWs");
function openHttp(url, jwt, customFetch, remoteEncryptionKey, protocolVersion = 2) {
  return new HttpClient(url instanceof URL ? url : new URL(url), jwt, customFetch, remoteEncryptionKey, protocolVersion);
}
__name(openHttp, "openHttp");

// node_modules/@libsql/client/lib-esm/hrana.js
var HranaTransaction = class {
  static {
    __name(this, "HranaTransaction");
  }
  #mode;
  #version;
  // Promise that is resolved when the BEGIN statement completes, or `undefined` if we haven't executed the
  // BEGIN statement yet.
  #started;
  /** @private */
  constructor(mode, version2) {
    this.#mode = mode;
    this.#version = version2;
    this.#started = void 0;
  }
  execute(stmt) {
    return this.batch([stmt]).then((results) => results[0]);
  }
  async batch(stmts) {
    const stream = this._getStream();
    if (stream.closed) {
      throw new LibsqlError("Cannot execute statements because the transaction is closed", "TRANSACTION_CLOSED");
    }
    try {
      const hranaStmts = stmts.map(stmtToHrana);
      let rowsPromises;
      if (this.#started === void 0) {
        this._getSqlCache().apply(hranaStmts);
        const batch = stream.batch(this.#version >= 3);
        const beginStep = batch.step();
        const beginPromise = beginStep.run(transactionModeToBegin(this.#mode));
        let lastStep = beginStep;
        rowsPromises = hranaStmts.map((hranaStmt) => {
          const stmtStep = batch.step().condition(BatchCond.ok(lastStep));
          if (this.#version >= 3) {
            stmtStep.condition(BatchCond.not(BatchCond.isAutocommit(batch)));
          }
          const rowsPromise = stmtStep.query(hranaStmt);
          rowsPromise.catch(() => void 0);
          lastStep = stmtStep;
          return rowsPromise;
        });
        this.#started = batch.execute().then(() => beginPromise).then(() => void 0);
        try {
          await this.#started;
        } catch (e) {
          this.close();
          throw e;
        }
      } else {
        if (this.#version < 3) {
          await this.#started;
        } else {
        }
        this._getSqlCache().apply(hranaStmts);
        const batch = stream.batch(this.#version >= 3);
        let lastStep = void 0;
        rowsPromises = hranaStmts.map((hranaStmt) => {
          const stmtStep = batch.step();
          if (lastStep !== void 0) {
            stmtStep.condition(BatchCond.ok(lastStep));
          }
          if (this.#version >= 3) {
            stmtStep.condition(BatchCond.not(BatchCond.isAutocommit(batch)));
          }
          const rowsPromise = stmtStep.query(hranaStmt);
          rowsPromise.catch(() => void 0);
          lastStep = stmtStep;
          return rowsPromise;
        });
        await batch.execute();
      }
      const resultSets = [];
      for (let i = 0; i < rowsPromises.length; i++) {
        try {
          const rows = await rowsPromises[i];
          if (rows === void 0) {
            throw new LibsqlBatchError("Statement in a transaction was not executed, probably because the transaction has been rolled back", i, "TRANSACTION_CLOSED");
          }
          resultSets.push(resultSetFromHrana(rows));
        } catch (e) {
          if (e instanceof LibsqlBatchError) {
            throw e;
          }
          const mappedError = mapHranaError(e);
          if (mappedError instanceof LibsqlError) {
            throw new LibsqlBatchError(mappedError.message, i, mappedError.code, mappedError.extendedCode, mappedError.rawCode, mappedError.cause instanceof Error ? mappedError.cause : void 0);
          }
          throw mappedError;
        }
      }
      return resultSets;
    } catch (e) {
      throw mapHranaError(e);
    }
  }
  async executeMultiple(sql) {
    const stream = this._getStream();
    if (stream.closed) {
      throw new LibsqlError("Cannot execute statements because the transaction is closed", "TRANSACTION_CLOSED");
    }
    try {
      if (this.#started === void 0) {
        this.#started = stream.run(transactionModeToBegin(this.#mode)).then(() => void 0);
        try {
          await this.#started;
        } catch (e) {
          this.close();
          throw e;
        }
      } else {
        await this.#started;
      }
      await stream.sequence(sql);
    } catch (e) {
      throw mapHranaError(e);
    }
  }
  async rollback() {
    try {
      const stream = this._getStream();
      if (stream.closed) {
        return;
      }
      if (this.#started !== void 0) {
      } else {
        return;
      }
      const promise = stream.run("ROLLBACK").catch((e) => {
        throw mapHranaError(e);
      });
      stream.closeGracefully();
      await promise;
    } catch (e) {
      throw mapHranaError(e);
    } finally {
      this.close();
    }
  }
  async commit() {
    try {
      const stream = this._getStream();
      if (stream.closed) {
        throw new LibsqlError("Cannot commit the transaction because it is already closed", "TRANSACTION_CLOSED");
      }
      if (this.#started !== void 0) {
        await this.#started;
      } else {
        return;
      }
      const promise = stream.run("COMMIT").catch((e) => {
        throw mapHranaError(e);
      });
      stream.closeGracefully();
      await promise;
    } catch (e) {
      throw mapHranaError(e);
    } finally {
      this.close();
    }
  }
};
async function executeHranaBatch(mode, version2, batch, hranaStmts, disableForeignKeys = false) {
  if (disableForeignKeys) {
    batch.step().run("PRAGMA foreign_keys=off");
  }
  const beginStep = batch.step();
  const beginPromise = beginStep.run(transactionModeToBegin(mode));
  let lastStep = beginStep;
  const stmtPromises = hranaStmts.map((hranaStmt) => {
    const stmtStep = batch.step().condition(BatchCond.ok(lastStep));
    if (version2 >= 3) {
      stmtStep.condition(BatchCond.not(BatchCond.isAutocommit(batch)));
    }
    const stmtPromise = stmtStep.query(hranaStmt);
    lastStep = stmtStep;
    return stmtPromise;
  });
  const commitStep = batch.step().condition(BatchCond.ok(lastStep));
  if (version2 >= 3) {
    commitStep.condition(BatchCond.not(BatchCond.isAutocommit(batch)));
  }
  const commitPromise = commitStep.run("COMMIT");
  const rollbackStep = batch.step().condition(BatchCond.not(BatchCond.ok(commitStep)));
  rollbackStep.run("ROLLBACK").catch((_) => void 0);
  if (disableForeignKeys) {
    batch.step().run("PRAGMA foreign_keys=on");
  }
  await batch.execute();
  const resultSets = [];
  await beginPromise;
  for (let i = 0; i < stmtPromises.length; i++) {
    try {
      const hranaRows = await stmtPromises[i];
      if (hranaRows === void 0) {
        throw new LibsqlBatchError("Statement in a batch was not executed, probably because the transaction has been rolled back", i, "TRANSACTION_CLOSED");
      }
      resultSets.push(resultSetFromHrana(hranaRows));
    } catch (e) {
      if (e instanceof LibsqlBatchError) {
        throw e;
      }
      const mappedError = mapHranaError(e);
      if (mappedError instanceof LibsqlError) {
        throw new LibsqlBatchError(mappedError.message, i, mappedError.code, mappedError.extendedCode, mappedError.rawCode, mappedError.cause instanceof Error ? mappedError.cause : void 0);
      }
      throw mappedError;
    }
  }
  await commitPromise;
  return resultSets;
}
__name(executeHranaBatch, "executeHranaBatch");
function stmtToHrana(stmt) {
  let sql;
  let args;
  if (Array.isArray(stmt)) {
    [sql, args] = stmt;
  } else if (typeof stmt === "string") {
    sql = stmt;
  } else {
    sql = stmt.sql;
    args = stmt.args;
  }
  const hranaStmt = new Stmt(sql);
  if (args) {
    if (Array.isArray(args)) {
      hranaStmt.bindIndexes(args);
    } else {
      for (const [key, value] of Object.entries(args)) {
        hranaStmt.bindName(key, value);
      }
    }
  }
  return hranaStmt;
}
__name(stmtToHrana, "stmtToHrana");
function resultSetFromHrana(hranaRows) {
  const columns = hranaRows.columnNames.map((c) => c ?? "");
  const columnTypes = hranaRows.columnDecltypes.map((c) => c ?? "");
  const rows = hranaRows.rows;
  const rowsAffected = hranaRows.affectedRowCount;
  const lastInsertRowid = hranaRows.lastInsertRowid !== void 0 ? hranaRows.lastInsertRowid : void 0;
  return new ResultSetImpl(columns, columnTypes, rows, rowsAffected, lastInsertRowid);
}
__name(resultSetFromHrana, "resultSetFromHrana");
function mapHranaError(e) {
  if (e instanceof ClientError) {
    const code = mapHranaErrorCode(e);
    return new LibsqlError(e.message, code, void 0, void 0, e);
  }
  return e;
}
__name(mapHranaError, "mapHranaError");
function mapHranaErrorCode(e) {
  if (e instanceof ResponseError && e.code !== void 0) {
    return e.code;
  } else if (e instanceof ProtoError) {
    return "HRANA_PROTO_ERROR";
  } else if (e instanceof ClosedError) {
    return e.cause instanceof ClientError ? mapHranaErrorCode(e.cause) : "HRANA_CLOSED_ERROR";
  } else if (e instanceof WebSocketError) {
    return "HRANA_WEBSOCKET_ERROR";
  } else if (e instanceof HttpServerError) {
    return "SERVER_ERROR";
  } else if (e instanceof ProtocolVersionError) {
    return "PROTOCOL_VERSION_ERROR";
  } else if (e instanceof InternalError) {
    return "INTERNAL_ERROR";
  } else {
    return "UNKNOWN";
  }
}
__name(mapHranaErrorCode, "mapHranaErrorCode");

// node_modules/@libsql/client/lib-esm/sql_cache.js
var SqlCache = class {
  static {
    __name(this, "SqlCache");
  }
  #owner;
  #sqls;
  capacity;
  constructor(owner, capacity) {
    this.#owner = owner;
    this.#sqls = new Lru();
    this.capacity = capacity;
  }
  // Replaces SQL strings with cached `hrana.Sql` objects in the statements in `hranaStmts`. After this
  // function returns, we guarantee that all `hranaStmts` refer to valid (not closed) `hrana.Sql` objects,
  // but _we may invalidate any other `hrana.Sql` objects_ (by closing them, thus removing them from the
  // server).
  //
  // In practice, this means that after calling this function, you can use the statements only up to the
  // first `await`, because concurrent code may also use the cache and invalidate those statements.
  apply(hranaStmts) {
    if (this.capacity <= 0) {
      return;
    }
    const usedSqlObjs = /* @__PURE__ */ new Set();
    for (const hranaStmt of hranaStmts) {
      if (typeof hranaStmt.sql !== "string") {
        continue;
      }
      const sqlText = hranaStmt.sql;
      if (sqlText.length >= 5e3) {
        continue;
      }
      let sqlObj = this.#sqls.get(sqlText);
      if (sqlObj === void 0) {
        while (this.#sqls.size + 1 > this.capacity) {
          const [evictSqlText, evictSqlObj] = this.#sqls.peekLru();
          if (usedSqlObjs.has(evictSqlObj)) {
            break;
          }
          evictSqlObj.close();
          this.#sqls.delete(evictSqlText);
        }
        if (this.#sqls.size + 1 <= this.capacity) {
          sqlObj = this.#owner.storeSql(sqlText);
          this.#sqls.set(sqlText, sqlObj);
        }
      }
      if (sqlObj !== void 0) {
        hranaStmt.sql = sqlObj;
        usedSqlObjs.add(sqlObj);
      }
    }
  }
};
var Lru = class {
  static {
    __name(this, "Lru");
  }
  // This maps keys to the cache values. The entries are ordered by their last use (entires that were used
  // most recently are at the end).
  #cache;
  constructor() {
    this.#cache = /* @__PURE__ */ new Map();
  }
  get(key) {
    const value = this.#cache.get(key);
    if (value !== void 0) {
      this.#cache.delete(key);
      this.#cache.set(key, value);
    }
    return value;
  }
  set(key, value) {
    this.#cache.set(key, value);
  }
  peekLru() {
    for (const entry of this.#cache.entries()) {
      return entry;
    }
    return void 0;
  }
  delete(key) {
    this.#cache.delete(key);
  }
  get size() {
    return this.#cache.size;
  }
};

// node_modules/@libsql/client/lib-esm/ws.js
var import_promise_limit = __toESM(require_promise_limit(), 1);
function _createClient(config) {
  if (config.scheme !== "wss" && config.scheme !== "ws") {
    throw new LibsqlError(`The WebSocket client supports only "libsql:", "wss:" and "ws:" URLs, got ${JSON.stringify(config.scheme + ":")}. For more information, please read ${supportedUrlLink}`, "URL_SCHEME_NOT_SUPPORTED");
  }
  if (config.encryptionKey !== void 0) {
    throw new LibsqlError("Encryption key is not supported by the remote client.", "ENCRYPTION_KEY_NOT_SUPPORTED");
  }
  if (config.scheme === "ws" && config.tls) {
    throw new LibsqlError(`A "ws:" URL cannot opt into TLS by using ?tls=1`, "URL_INVALID");
  } else if (config.scheme === "wss" && !config.tls) {
    throw new LibsqlError(`A "wss:" URL cannot opt out of TLS by using ?tls=0`, "URL_INVALID");
  }
  const url = encodeBaseUrl(config.scheme, config.authority, config.path);
  let client;
  try {
    client = openWs(url, config.authToken);
  } catch (e) {
    if (e instanceof WebSocketUnsupportedError) {
      const suggestedScheme = config.scheme === "wss" ? "https" : "http";
      const suggestedUrl = encodeBaseUrl(suggestedScheme, config.authority, config.path);
      throw new LibsqlError(`This environment does not support WebSockets, please switch to the HTTP client by using a "${suggestedScheme}:" URL (${JSON.stringify(suggestedUrl)}). For more information, please read ${supportedUrlLink}`, "WEBSOCKETS_NOT_SUPPORTED");
    }
    throw mapHranaError(e);
  }
  return new WsClient2(client, url, config.authToken, config.intMode, config.concurrency);
}
__name(_createClient, "_createClient");
var maxConnAgeMillis = 60 * 1e3;
var sqlCacheCapacity = 100;
var WsClient2 = class {
  static {
    __name(this, "WsClient");
  }
  #url;
  #authToken;
  #intMode;
  // State of the current connection. The `hrana.WsClient` inside may be closed at any moment due to an
  // asynchronous error.
  #connState;
  // If defined, this is a connection that will be used in the future, once it is ready.
  #futureConnState;
  closed;
  protocol;
  #isSchemaDatabase;
  #promiseLimitFunction;
  /** @private */
  constructor(client, url, authToken, intMode, concurrency) {
    this.#url = url;
    this.#authToken = authToken;
    this.#intMode = intMode;
    this.#connState = this.#openConn(client);
    this.#futureConnState = void 0;
    this.closed = false;
    this.protocol = "ws";
    this.#promiseLimitFunction = (0, import_promise_limit.default)(concurrency);
  }
  async limit(fn) {
    return this.#promiseLimitFunction(fn);
  }
  async execute(stmtOrSql, args) {
    let stmt;
    if (typeof stmtOrSql === "string") {
      stmt = {
        sql: stmtOrSql,
        args: args || []
      };
    } else {
      stmt = stmtOrSql;
    }
    return this.limit(async () => {
      const streamState = await this.#openStream();
      try {
        const hranaStmt = stmtToHrana(stmt);
        streamState.conn.sqlCache.apply([hranaStmt]);
        const hranaRowsPromise = streamState.stream.query(hranaStmt);
        streamState.stream.closeGracefully();
        const hranaRowsResult = await hranaRowsPromise;
        return resultSetFromHrana(hranaRowsResult);
      } catch (e) {
        throw mapHranaError(e);
      } finally {
        this._closeStream(streamState);
      }
    });
  }
  async batch(stmts, mode = "deferred") {
    return this.limit(async () => {
      const streamState = await this.#openStream();
      try {
        const normalizedStmts = stmts.map((stmt) => {
          if (Array.isArray(stmt)) {
            return {
              sql: stmt[0],
              args: stmt[1] || []
            };
          }
          return stmt;
        });
        const hranaStmts = normalizedStmts.map(stmtToHrana);
        const version2 = await streamState.conn.client.getVersion();
        streamState.conn.sqlCache.apply(hranaStmts);
        const batch = streamState.stream.batch(version2 >= 3);
        const resultsPromise = executeHranaBatch(mode, version2, batch, hranaStmts);
        const results = await resultsPromise;
        return results;
      } catch (e) {
        throw mapHranaError(e);
      } finally {
        this._closeStream(streamState);
      }
    });
  }
  async migrate(stmts) {
    return this.limit(async () => {
      const streamState = await this.#openStream();
      try {
        const hranaStmts = stmts.map(stmtToHrana);
        const version2 = await streamState.conn.client.getVersion();
        const batch = streamState.stream.batch(version2 >= 3);
        const resultsPromise = executeHranaBatch("deferred", version2, batch, hranaStmts, true);
        const results = await resultsPromise;
        return results;
      } catch (e) {
        throw mapHranaError(e);
      } finally {
        this._closeStream(streamState);
      }
    });
  }
  async transaction(mode = "write") {
    return this.limit(async () => {
      const streamState = await this.#openStream();
      try {
        const version2 = await streamState.conn.client.getVersion();
        return new WsTransaction(this, streamState, mode, version2);
      } catch (e) {
        this._closeStream(streamState);
        throw mapHranaError(e);
      }
    });
  }
  async executeMultiple(sql) {
    return this.limit(async () => {
      const streamState = await this.#openStream();
      try {
        const promise = streamState.stream.sequence(sql);
        streamState.stream.closeGracefully();
        await promise;
      } catch (e) {
        throw mapHranaError(e);
      } finally {
        this._closeStream(streamState);
      }
    });
  }
  sync() {
    throw new LibsqlError("sync not supported in ws mode", "SYNC_NOT_SUPPORTED");
  }
  async #openStream() {
    if (this.closed) {
      throw new LibsqlError("The client is closed", "CLIENT_CLOSED");
    }
    const now = /* @__PURE__ */ new Date();
    const ageMillis = now.valueOf() - this.#connState.openTime.valueOf();
    if (ageMillis > maxConnAgeMillis && this.#futureConnState === void 0) {
      const futureConnState = this.#openConn();
      this.#futureConnState = futureConnState;
      futureConnState.client.getVersion().then((_version) => {
        if (this.#connState !== futureConnState) {
          if (this.#connState.streamStates.size === 0) {
            this.#connState.client.close();
          } else {
          }
        }
        this.#connState = futureConnState;
        this.#futureConnState = void 0;
      }, (_e) => {
        this.#futureConnState = void 0;
      });
    }
    if (this.#connState.client.closed) {
      try {
        if (this.#futureConnState !== void 0) {
          this.#connState = this.#futureConnState;
        } else {
          this.#connState = this.#openConn();
        }
      } catch (e) {
        throw mapHranaError(e);
      }
    }
    const connState = this.#connState;
    try {
      if (connState.useSqlCache === void 0) {
        connState.useSqlCache = await connState.client.getVersion() >= 2;
        if (connState.useSqlCache) {
          connState.sqlCache.capacity = sqlCacheCapacity;
        }
      }
      const stream = connState.client.openStream();
      stream.intMode = this.#intMode;
      const streamState = { conn: connState, stream };
      connState.streamStates.add(streamState);
      return streamState;
    } catch (e) {
      throw mapHranaError(e);
    }
  }
  #openConn(client) {
    try {
      client ??= openWs(this.#url, this.#authToken);
      return {
        client,
        useSqlCache: void 0,
        sqlCache: new SqlCache(client, 0),
        openTime: /* @__PURE__ */ new Date(),
        streamStates: /* @__PURE__ */ new Set()
      };
    } catch (e) {
      throw mapHranaError(e);
    }
  }
  async reconnect() {
    try {
      for (const st of Array.from(this.#connState.streamStates)) {
        try {
          st.stream.close();
        } catch {
        }
      }
      this.#connState.client.close();
    } catch {
    }
    if (this.#futureConnState) {
      try {
        this.#futureConnState.client.close();
      } catch {
      }
      this.#futureConnState = void 0;
    }
    const next = this.#openConn();
    const version2 = await next.client.getVersion();
    next.useSqlCache = version2 >= 2;
    if (next.useSqlCache) {
      next.sqlCache.capacity = sqlCacheCapacity;
    }
    this.#connState = next;
    this.closed = false;
  }
  _closeStream(streamState) {
    streamState.stream.close();
    const connState = streamState.conn;
    connState.streamStates.delete(streamState);
    if (connState.streamStates.size === 0 && connState !== this.#connState) {
      connState.client.close();
    }
  }
  close() {
    this.#connState.client.close();
    this.closed = true;
    if (this.#futureConnState) {
      try {
        this.#futureConnState.client.close();
      } catch {
      }
      this.#futureConnState = void 0;
    }
    this.closed = true;
  }
};
var WsTransaction = class extends HranaTransaction {
  static {
    __name(this, "WsTransaction");
  }
  #client;
  #streamState;
  /** @private */
  constructor(client, state, mode, version2) {
    super(mode, version2);
    this.#client = client;
    this.#streamState = state;
  }
  /** @private */
  _getStream() {
    return this.#streamState.stream;
  }
  /** @private */
  _getSqlCache() {
    return this.#streamState.conn.sqlCache;
  }
  close() {
    this.#client._closeStream(this.#streamState);
  }
  get closed() {
    return this.#streamState.stream.closed;
  }
};

// node_modules/@libsql/client/lib-esm/http.js
var import_promise_limit2 = __toESM(require_promise_limit(), 1);
function _createClient2(config) {
  if (config.scheme !== "https" && config.scheme !== "http") {
    throw new LibsqlError(`The HTTP client supports only "libsql:", "https:" and "http:" URLs, got ${JSON.stringify(config.scheme + ":")}. For more information, please read ${supportedUrlLink}`, "URL_SCHEME_NOT_SUPPORTED");
  }
  if (config.encryptionKey !== void 0) {
    throw new LibsqlError("Encryption key is not supported by the remote client.", "ENCRYPTION_KEY_NOT_SUPPORTED");
  }
  if (config.scheme === "http" && config.tls) {
    throw new LibsqlError(`A "http:" URL cannot opt into TLS by using ?tls=1`, "URL_INVALID");
  } else if (config.scheme === "https" && !config.tls) {
    throw new LibsqlError(`A "https:" URL cannot opt out of TLS by using ?tls=0`, "URL_INVALID");
  }
  const url = encodeBaseUrl(config.scheme, config.authority, config.path);
  return new HttpClient2(url, config.authToken, config.intMode, config.fetch, config.concurrency, config.remoteEncryptionKey);
}
__name(_createClient2, "_createClient");
var sqlCacheCapacity2 = 30;
var HttpClient2 = class {
  static {
    __name(this, "HttpClient");
  }
  #client;
  protocol;
  #url;
  #intMode;
  #customFetch;
  #concurrency;
  #authToken;
  #remoteEncryptionKey;
  #promiseLimitFunction;
  /** @private */
  constructor(url, authToken, intMode, customFetch, concurrency, remoteEncryptionKey) {
    this.#url = url;
    this.#authToken = authToken;
    this.#intMode = intMode;
    this.#customFetch = customFetch;
    this.#concurrency = concurrency;
    this.#remoteEncryptionKey = remoteEncryptionKey;
    this.#client = openHttp(this.#url, this.#authToken, this.#customFetch, remoteEncryptionKey);
    this.#client.intMode = this.#intMode;
    this.protocol = "http";
    this.#promiseLimitFunction = (0, import_promise_limit2.default)(this.#concurrency);
  }
  async limit(fn) {
    return this.#promiseLimitFunction(fn);
  }
  async execute(stmtOrSql, args) {
    let stmt;
    if (typeof stmtOrSql === "string") {
      stmt = {
        sql: stmtOrSql,
        args: args || []
      };
    } else {
      stmt = stmtOrSql;
    }
    return this.limit(async () => {
      try {
        const hranaStmt = stmtToHrana(stmt);
        let rowsPromise;
        const stream = this.#client.openStream();
        try {
          rowsPromise = stream.query(hranaStmt);
        } finally {
          stream.closeGracefully();
        }
        const rowsResult = await rowsPromise;
        return resultSetFromHrana(rowsResult);
      } catch (e) {
        throw mapHranaError(e);
      }
    });
  }
  async batch(stmts, mode = "deferred") {
    return this.limit(async () => {
      try {
        const normalizedStmts = stmts.map((stmt) => {
          if (Array.isArray(stmt)) {
            return {
              sql: stmt[0],
              args: stmt[1] || []
            };
          }
          return stmt;
        });
        const hranaStmts = normalizedStmts.map(stmtToHrana);
        const version2 = await this.#client.getVersion();
        let resultsPromise;
        const stream = this.#client.openStream();
        try {
          const sqlCache = new SqlCache(stream, sqlCacheCapacity2);
          sqlCache.apply(hranaStmts);
          const batch = stream.batch(false);
          resultsPromise = executeHranaBatch(mode, version2, batch, hranaStmts);
        } finally {
          stream.closeGracefully();
        }
        const results = await resultsPromise;
        return results;
      } catch (e) {
        throw mapHranaError(e);
      }
    });
  }
  async migrate(stmts) {
    return this.limit(async () => {
      try {
        const hranaStmts = stmts.map(stmtToHrana);
        const version2 = await this.#client.getVersion();
        let resultsPromise;
        const stream = this.#client.openStream();
        try {
          const batch = stream.batch(false);
          resultsPromise = executeHranaBatch("deferred", version2, batch, hranaStmts, true);
        } finally {
          stream.closeGracefully();
        }
        const results = await resultsPromise;
        return results;
      } catch (e) {
        throw mapHranaError(e);
      }
    });
  }
  async transaction(mode = "write") {
    return this.limit(async () => {
      try {
        const version2 = await this.#client.getVersion();
        return new HttpTransaction(this.#client.openStream(), mode, version2);
      } catch (e) {
        throw mapHranaError(e);
      }
    });
  }
  async executeMultiple(sql) {
    return this.limit(async () => {
      try {
        let promise;
        const stream = this.#client.openStream();
        try {
          promise = stream.sequence(sql);
        } finally {
          stream.closeGracefully();
        }
        await promise;
      } catch (e) {
        throw mapHranaError(e);
      }
    });
  }
  sync() {
    throw new LibsqlError("sync not supported in http mode", "SYNC_NOT_SUPPORTED");
  }
  close() {
    this.#client.close();
  }
  async reconnect() {
    try {
      if (!this.closed) {
        this.#client.close();
      }
    } finally {
      this.#client = openHttp(this.#url, this.#authToken, this.#customFetch, this.#remoteEncryptionKey);
      this.#client.intMode = this.#intMode;
    }
  }
  get closed() {
    return this.#client.closed;
  }
};
var HttpTransaction = class extends HranaTransaction {
  static {
    __name(this, "HttpTransaction");
  }
  #stream;
  #sqlCache;
  /** @private */
  constructor(stream, mode, version2) {
    super(mode, version2);
    this.#stream = stream;
    this.#sqlCache = new SqlCache(stream, sqlCacheCapacity2);
  }
  /** @private */
  _getStream() {
    return this.#stream;
  }
  /** @private */
  _getSqlCache() {
    return this.#sqlCache;
  }
  close() {
    this.#stream.close();
  }
  get closed() {
    return this.#stream.closed;
  }
};

// node_modules/@libsql/client/lib-esm/web.js
function createClient(config) {
  return _createClient3(expandConfig(config, true));
}
__name(createClient, "createClient");
function _createClient3(config) {
  if (config.scheme === "ws" || config.scheme === "wss") {
    return _createClient(config);
  } else if (config.scheme === "http" || config.scheme === "https") {
    return _createClient2(config);
  } else {
    throw new LibsqlError(`The client that uses Web standard APIs supports only "libsql:", "wss:", "ws:", "https:" and "http:" URLs, got ${JSON.stringify(config.scheme + ":")}. For more information, please read ${supportedUrlLink}`, "URL_SCHEME_NOT_SUPPORTED");
  }
}
__name(_createClient3, "_createClient");

// api/cf-worker.js
var import_bcryptjs = __toESM(require_bcrypt());
var _b64decode = /* @__PURE__ */ __name((b64) => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}, "_b64decode");
var app = new Hono2();
var JWT_SECRET = "priv-spaca-dev-secret-change-me";
var GITHUB_PAT = "";
var TURSO_DATABASE_URL = "";
var TURSO_AUTH_TOKEN = "";
var GH_REPO = "ajitjaat1011-ui/PRIV-SPACA";
var GH_BRANCH = "data";
var GH_FILE = "db.json";
var VAPID_PUBLIC = "BG5msm1YiW_5l5N2ZNAvz5CkzQDGchg99ZSpkXVhXb4mm70X8vPPZs_7lrsaDXtvPns7QloRkh40vY4J5O0pqlI";
var VAPID_PRIVATE = "";
var VAPID_SUBJECT = "mailto:admin@priv-spaca.app";
var ADMIN_USERS = "Arvindjaat1011,ajitjaat1011@gmail.com,arvindjaat1011@gmail.com";
var OWNER_EMAIL = "ajitjaat1011@gmail.com";
var OWNER_USERNAME = "Arvindjaat1011";
var VIP_UNLOCK_KEY = "";
var CLOUDINARY_CLOUD_NAME = "";
var CLOUDINARY_API_KEY = "";
var CLOUDINARY_API_SECRET = "";
var CLOUDINARY_FOLDER = "priv-spaca";
function isAllowedCorsOrigin(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const h = u.hostname.toLowerCase();
    if (h === "priv-spaca.pages.dev" || h.endsWith(".priv-spaca.pages.dev")) return true;
    if (h === "localhost" || h === "127.0.0.1") return true;
  } catch (_) {
  }
  return false;
}
__name(isAllowedCorsOrigin, "isAllowedCorsOrigin");
function applyCors(c) {
  const origin = c.req.header("origin") || "";
  if (origin && isAllowedCorsOrigin(origin)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
  }
  c.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Last-Event-ID");
  c.header("Access-Control-Max-Age", "86400");
}
__name(applyCors, "applyCors");
function isDefaultJwtSecret() {
  return !JWT_SECRET || JWT_SECRET === "priv-spaca-dev-secret-change-me";
}
__name(isDefaultJwtSecret, "isDefaultJwtSecret");
function isProductionRequest(c) {
  const host = new URL(c.req.url).hostname.toLowerCase();
  return host.endsWith("priv-spaca.pages.dev") || host === "priv-spaca.pages.dev";
}
__name(isProductionRequest, "isProductionRequest");
function loadConfig(env) {
  if (!env) return;
  if (env.JWT_SECRET) JWT_SECRET = env.JWT_SECRET;
  if (env.GITHUB_PAT) GITHUB_PAT = env.GITHUB_PAT;
  if (env.TURSO_DATABASE_URL) TURSO_DATABASE_URL = String(env.TURSO_DATABASE_URL).trim();
  if (env.TURSO_AUTH_TOKEN) TURSO_AUTH_TOKEN = String(env.TURSO_AUTH_TOKEN).trim();
  if (env.GH_REPO) GH_REPO = env.GH_REPO;
  if (env.GH_BRANCH) GH_BRANCH = env.GH_BRANCH;
  if (env.GH_FILE) GH_FILE = env.GH_FILE;
  if (env.VAPID_PUBLIC_KEY) VAPID_PUBLIC = env.VAPID_PUBLIC_KEY;
  if (env.VAPID_PRIVATE_KEY) VAPID_PRIVATE = env.VAPID_PRIVATE_KEY;
  if (env.VAPID_SUBJECT) VAPID_SUBJECT = env.VAPID_SUBJECT;
  if (env.ADMIN_USERS) ADMIN_USERS = env.ADMIN_USERS;
  if (env.OWNER_EMAIL) OWNER_EMAIL = env.OWNER_EMAIL;
  if (env.OWNER_USERNAME) OWNER_USERNAME = env.OWNER_USERNAME;
  if (env.VIP_UNLOCK_KEY) VIP_UNLOCK_KEY = env.VIP_UNLOCK_KEY;
  if (env.CLOUDINARY_CLOUD_NAME) CLOUDINARY_CLOUD_NAME = env.CLOUDINARY_CLOUD_NAME;
  if (env.CLOUDINARY_API_KEY) CLOUDINARY_API_KEY = env.CLOUDINARY_API_KEY;
  if (env.CLOUDINARY_API_SECRET) CLOUDINARY_API_SECRET = env.CLOUDINARY_API_SECRET;
  if (env.CLOUDINARY_FOLDER) CLOUDINARY_FOLDER = env.CLOUDINARY_FOLDER;
}
__name(loadConfig, "loadConfig");
var JWT_EXPIRES_DAYS = 7;
var PASSWORD_HASH_ROUNDS = 6;
var CACHE_TTL_MS = 500;
var EPHEMERAL_WRITE_INTERVAL_MS = 3e4;
var localCache = {
  users: [],
  messages: [],
  scheduledMessages: [],
  posts: [],
  notifications: [],
  typing: {},
  heartbeat: {},
  rtcSignals: []
};
var cacheTimestamp = 0;
var lastEphemeralWrite = 0;
var ghFileSha = null;
var nowMs = /* @__PURE__ */ __name(() => Date.now(), "nowMs");
var sleepMs = /* @__PURE__ */ __name((ms) => new Promise((r) => setTimeout(r, ms)), "sleepMs");
var uid = /* @__PURE__ */ __name((p = "id") => p + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9), "uid");
var safeJson = /* @__PURE__ */ __name((s, f) => {
  try {
    return JSON.parse(s);
  } catch (_) {
    return f;
  }
}, "safeJson");
var isRepo = /* @__PURE__ */ __name(() => !!(GITHUB_PAT && GH_REPO && GH_BRANCH), "isRepo");
var isPersist = /* @__PURE__ */ __name(() => isTursoPrimary() || isRepo(), "isPersist");
var isEmail = /* @__PURE__ */ __name((s) => typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s), "isEmail");
var isUsername = /* @__PURE__ */ __name((s) => typeof s === "string" && /^[a-zA-Z0-9_]{3,24}$/.test(s), "isUsername");
var isPin = /* @__PURE__ */ __name((s) => typeof s === "string" && /^\d{4}$/.test(s), "isPin");
function sanitizeText(s, max = 4e3) {
  if (typeof s !== "string") return "";
  return s.normalize("NFKC").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "").slice(0, max);
}
__name(sanitizeText, "sanitizeText");
function normalizeAuthIdentifier(v) {
  return sanitizeText(String(v || ""), 254).trim().toLowerCase();
}
__name(normalizeAuthIdentifier, "normalizeAuthIdentifier");
function isSafeMediaUrl(url, { allowData = true } = {}) {
  if (typeof url !== "string") return false;
  const u = url.trim();
  if (!u || u.length > 4096) return false;
  if (/^https?:\/\//i.test(u)) return true;
  if (allowData && /^data:(image|audio|video)\/(jpeg|jpg|png|webp|gif|webm|mp3|mp4|quicktime|mov);base64,[a-z0-9+/=]+$/i.test(u)) return true;
  return false;
}
__name(isSafeMediaUrl, "isSafeMediaUrl");
function isSafeImageUrl(url, { allowData = true } = {}) {
  if (typeof url !== "string") return false;
  const u = url.trim();
  if (!u || u.length > 4096) return false;
  if (/^https?:\/\//i.test(u)) return true;
  if (allowData && /^data:image\/(jpeg|jpg|png|webp|gif);base64,[a-z0-9+/=]+$/i.test(u)) return true;
  return false;
}
__name(isSafeImageUrl, "isSafeImageUrl");
function isSafeHttpsUrl(url, maxLen = 2048) {
  if (typeof url !== "string") return false;
  const u = url.trim();
  if (!u || u.length > maxLen) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:";
  } catch (_) {
    return false;
  }
}
__name(isSafeHttpsUrl, "isSafeHttpsUrl");
function isValidPushSubscription(sub) {
  if (!sub || typeof sub !== "object") return false;
  if (!isSafeHttpsUrl(sub.endpoint, 2048)) return false;
  const keys = sub.keys;
  if (!keys || typeof keys !== "object") return false;
  const p256dh = String(keys.p256dh || "");
  const auth = String(keys.auth || "");
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(p256dh)) return false;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(auth)) return false;
  return true;
}
__name(isValidPushSubscription, "isValidPushSubscription");
function isStoryRecord(post) {
  if (!post) return false;
  return !!(post.story === true || post.kind === "story" || post.storyExpiresAt);
}
__name(isStoryRecord, "isStoryRecord");
function storyExpiresAt(post) {
  return Number(post && post.storyExpiresAt) || (post && post.createdAt ? post.createdAt + 24 * 60 * 60 * 1e3 : 0);
}
__name(storyExpiresAt, "storyExpiresAt");
function canViewerSeeStory(post, viewerId, db2) {
  if (!isStoryRecord(post)) return true;
  if (!post || post.deletedAt) return false;
  if (storyExpiresAt(post) <= nowMs()) return false;
  if (post.userId === viewerId) return true;
  if ((post.audience || "all") !== "close_friends") return true;
  const author = (db2.users || []).find((u) => u.id === post.userId);
  const closeFriends = Array.isArray(author && author.closeFriends) ? author.closeFriends : [];
  return closeFriends.includes(viewerId);
}
__name(canViewerSeeStory, "canViewerSeeStory");
function sanitizeUser(u, includePrivate = false) {
  if (!u) return null;
  const out = {
    id: u.id,
    email: u.email,
    username: u.username,
    displayName: u.displayName,
    bio: u.bio || "",
    photoUrl: u.photoUrl || "",
    createdAt: u.createdAt,
    publicKey: u.publicKey || null,
    verified: !!u.verified,
    note: activeNote(u)
  };
  if (includePrivate) {
    out.dateOfBirth = typeof u.dateOfBirth === "string" ? u.dateOfBirth : "";
    out.cardVisibility = ["everyone", "close_friends", "private"].includes(u.cardVisibility) ? u.cardVisibility : "everyone";
  }
  return out;
}
__name(sanitizeUser, "sanitizeUser");
function canViewProfileCard(owner, viewerId) {
  if (!owner || !viewerId) return false;
  if (owner.id === viewerId) return true;
  const mode = ["everyone", "close_friends", "private"].includes(owner.cardVisibility) ? owner.cardVisibility : "everyone";
  if (mode === "everyone") return true;
  if (mode === "close_friends") return Array.isArray(owner.closeFriends) && owner.closeFriends.includes(viewerId);
  return false;
}
__name(canViewProfileCard, "canViewProfileCard");
function activeNote(u) {
  const n = u && u.note;
  if (!n || !n.text && !n.music) return null;
  if (n.expiresAt && n.expiresAt <= nowMs()) return null;
  return { text: String(n.text || "").slice(0, 60), music: n.music || null, createdAt: n.createdAt || 0, expiresAt: n.expiresAt || 0 };
}
__name(activeNote, "activeNote");
function adminSet() {
  return new Set(String(ADMIN_USERS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
}
__name(adminSet, "adminSet");
function isAdminUser(u) {
  if (!u) return false;
  const set = adminSet();
  return set.has(String(u.username || "").toLowerCase()) || set.has(String(u.email || "").toLowerCase()) || set.has(String(u.id || "").toLowerCase());
}
__name(isAdminUser, "isAdminUser");
async function requireAdmin(c, next) {
  const auth = await requireAuth(c, async () => {
  });
  if (auth instanceof Response) return auth;
  const db2 = await fetchPrimaryDatabase();
  const u = db2.users.find((x) => x.id === c.get("userId"));
  if (!isAdminUser(u)) return c.json({ error: "Admin only" }, 403);
  c.set("adminUser", u);
  c.set("adminDb", db2);
  await next();
}
__name(requireAdmin, "requireAdmin");
function isTursoPrimary() {
  return isTursoConfigured();
}
__name(isTursoPrimary, "isTursoPrimary");
function isNeonPrimary() {
  return false;
}
__name(isNeonPrimary, "isNeonPrimary");
function primaryPersistenceName() {
  if (isTursoPrimary()) return "turso-libsql-primary";
  if (isRepo()) return "github-repo";
  return "in-memory";
}
__name(primaryPersistenceName, "primaryPersistenceName");
async function neonReadDb() {
  return null;
}
__name(neonReadDb, "neonReadDb");
async function neonWriteDb() {
  return false;
}
__name(neonWriteDb, "neonWriteDb");
async function repoRead() {
  if (isTursoPrimary()) return await tursoReadDb();
  if (isNeonPrimary()) return await neonReadDb();
  if (!isRepo()) return null;
  try {
    const url = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(GH_FILE)}?ref=${encodeURIComponent(GH_BRANCH)}&_=${Date.now()}`;
    const rSha = await fetch(url, {
      headers: { Authorization: "token " + GITHUB_PAT, "User-Agent": "PRIV-SPACA", Accept: "application/vnd.github+json", "Cache-Control": "no-cache" },
      cf: { cacheTtl: 0, cacheEverything: false }
    });
    if (!rSha.ok) return { _httpError: rSha.status, txt: await rSha.text() };
    const dSha = await rSha.json();
    if (dSha && dSha.sha) ghFileSha = dSha.sha;
    if (!dSha || !dSha.content) return null;
    const b64 = String(dSha.content || "").replace(/\n/g, "");
    const text = _b64decode(b64);
    return safeJson(text, { _err: "Invalid JSON", _textPreview: text.slice(0, 100) });
  } catch (e) {
    return { _err: e.message, _stack: e.stack };
  }
}
__name(repoRead, "repoRead");
async function repoWrite(dbObj) {
  if (isTursoPrimary()) return await tursoWriteDb(dbObj);
  if (isNeonPrimary()) return await neonWriteDb(dbObj);
  if (!isRepo()) return false;
  try {
    if (!ghFileSha) await repoRead();
    const str = JSON.stringify(dbObj);
    const bytes = new TextEncoder().encode(str);
    let binStr = "";
    for (let i = 0; i < bytes.byteLength; i++) binStr += String.fromCharCode(bytes[i]);
    const content = btoa(binStr);
    const url = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(GH_FILE)}`;
    const doPut = /* @__PURE__ */ __name(async (sha) => {
      const body = { message: "priv-spaca sync " + (/* @__PURE__ */ new Date()).toISOString(), content, branch: GH_BRANCH };
      if (sha) body.sha = sha;
      return fetch(url, {
        method: "PUT",
        headers: { Authorization: "token " + GITHUB_PAT, "User-Agent": "PRIV-SPACA", Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    }, "doPut");
    let r = await doPut(ghFileSha);
    if (r.status === 409 || r.status === 422) {
      const t = await r.text().catch(() => "");
      console.warn("[repoWrite conflict]", r.status, t.slice(0, 120));
      ghFileSha = null;
      return false;
    }
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.error("[repoWrite]", r.status, t.slice(0, 200));
      return false;
    }
    const j = await r.json();
    if (j && j.content && j.content.sha) ghFileSha = j.content.sha;
    return true;
  } catch (e) {
    console.error("[repoWrite]", e.message);
    return false;
  }
}
__name(repoWrite, "repoWrite");
function runScheduler(db2) {
  const now = nowMs();
  let changed = false;
  const PURGE = 30 * 24 * 3600 * 1e3;
  const bp = (db2.posts || []).length;
  db2.posts = (db2.posts || []).filter((p) => !p.deletedAt || now - p.deletedAt < PURGE);
  if (db2.posts.length !== bp) changed = true;
  const bm = (db2.messages || []).length;
  for (const m of db2.messages || []) {
    if (m.disappearAt && m.disappearAt <= now && !m.deletedAt) {
      m.deletedAt = now;
      m.disappeared = true;
      changed = true;
    }
  }
  db2.messages = (db2.messages || []).filter((m) => !m.deletedAt || now - m.deletedAt < PURGE);
  if (db2.messages.length !== bm) changed = true;
  if (db2.typing && typeof db2.typing === "object") {
    for (const room of Object.keys(db2.typing)) {
      const map = db2.typing[room];
      if (!map || typeof map !== "object") {
        delete db2.typing[room];
        continue;
      }
      for (const u of Object.keys(map)) if (now - (map[u] || 0) > 1e4) delete map[u];
      if (Object.keys(map).length === 0) delete db2.typing[room];
    }
  }
  if (Array.isArray(db2.rtcSignals)) {
    const beforeRtc = db2.rtcSignals.length;
    db2.rtcSignals = db2.rtcSignals.filter((x) => x && (!x.expiresAt || x.expiresAt > now));
    if (db2.rtcSignals.length !== beforeRtc) changed = true;
  } else {
    db2.rtcSignals = [];
    changed = true;
  }
  if (!Array.isArray(db2.scheduledMessages) || db2.scheduledMessages.length === 0) return changed;
  const due = [], remaining = [];
  for (const sm of db2.scheduledMessages) {
    if (sm && typeof sm.deliverAt === "number" && sm.deliverAt <= now) due.push(sm);
    else remaining.push(sm);
  }
  if (due.length === 0) return changed;
  for (const sm of due) {
    const author = db2.users.find((u) => u.id === sm.userId);
    const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || "" } : sm.authorSnapshot || null;
    db2.messages.push({
      id: sm.id || uid("msg"),
      roomId: sm.roomId,
      userId: sm.userId,
      text: sm.text || "",
      imageUrl: sm.imageUrl || null,
      replyTo: sm.replyTo || null,
      authorSnapshot: snap,
      createdAt: now,
      scheduledOriginally: true
    });
  }
  db2.scheduledMessages = remaining;
  return true;
}
__name(runScheduler, "runScheduler");
function normalizeDb(remote) {
  const r = remote && typeof remote === "object" ? remote : {};
  return {
    users: Array.isArray(r.users) ? r.users : [],
    messages: Array.isArray(r.messages) ? r.messages : [],
    scheduledMessages: Array.isArray(r.scheduledMessages) ? r.scheduledMessages : [],
    posts: Array.isArray(r.posts) ? r.posts : [],
    notifications: Array.isArray(r.notifications) ? r.notifications : [],
    typing: r.typing && typeof r.typing === "object" ? r.typing : {},
    heartbeat: r.heartbeat && typeof r.heartbeat === "object" ? r.heartbeat : {},
    rtcSignals: Array.isArray(r.rtcSignals) ? r.rtcSignals : [],
    meta: r.meta && typeof r.meta === "object" ? r.meta : {}
  };
}
__name(normalizeDb, "normalizeDb");
function mergeById(remoteArr, localArr) {
  const map = /* @__PURE__ */ new Map();
  for (const x of Array.isArray(remoteArr) ? remoteArr : []) if (x && x.id) map.set(x.id, x);
  for (const x of Array.isArray(localArr) ? localArr : []) if (x && x.id) {
    const prev = map.get(x.id) || {};
    const merged = { ...prev, ...x };
    if (prev.deletedAt && !merged.deletedAt) merged.deletedAt = prev.deletedAt;
    if (prev.seenAt && !merged.seenAt) merged.seenAt = prev.seenAt;
    map.set(x.id, merged);
  }
  return Array.from(map.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
__name(mergeById, "mergeById");
function mergeMaps(remoteObj, localObj) {
  return { ...remoteObj && typeof remoteObj === "object" ? remoteObj : {}, ...localObj && typeof localObj === "object" ? localObj : {} };
}
__name(mergeMaps, "mergeMaps");
function mergeDatabase(remoteRaw, localRaw) {
  const remote = normalizeDb(remoteRaw);
  const local = normalizeDb(localRaw);
  return {
    users: mergeById(remote.users, local.users),
    messages: mergeById(remote.messages, local.messages),
    scheduledMessages: mergeById(remote.scheduledMessages, local.scheduledMessages),
    posts: mergeById(remote.posts, local.posts),
    notifications: mergeById(remote.notifications, local.notifications),
    rtcSignals: mergeById(remote.rtcSignals, local.rtcSignals).slice(-200),
    typing: mergeMaps(remote.typing, local.typing),
    heartbeat: mergeMaps(remote.heartbeat, local.heartbeat),
    meta: { ...remote.meta, ...local.meta, updatedAt: nowMs(), storage: "github-merge-v3" }
  };
}
__name(mergeDatabase, "mergeDatabase");
var _turso = null;
var _tursoReady = false;
var _tursoBootstrapped = false;
function isTursoConfigured() {
  return !!(TURSO_DATABASE_URL && TURSO_AUTH_TOKEN);
}
__name(isTursoConfigured, "isTursoConfigured");
function tursoClient() {
  if (!_turso) _turso = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
  return _turso;
}
__name(tursoClient, "tursoClient");
async function tursoEnsure() {
  if (!isTursoConfigured()) return false;
  if (_tursoReady) return true;
  const c = tursoClient();
  await c.executeMultiple(`
    CREATE TABLE IF NOT EXISTS ps_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ps_rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_rate_limits_reset_at ON ps_rate_limits (reset_at);
    CREATE TABLE IF NOT EXISTS ps_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_events_user_ts ON ps_events (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ps_events_ts ON ps_events (created_at);
    CREATE TABLE IF NOT EXISTS ps_users (
      id TEXT PRIMARY KEY,
      username_lower TEXT,
      email_lower TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_users_username_lower ON ps_users (username_lower);
    CREATE INDEX IF NOT EXISTS idx_ps_users_email_lower ON ps_users (email_lower);
    CREATE TABLE IF NOT EXISTS ps_posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER,
      story INTEGER NOT NULL DEFAULT 0,
      story_expires_at INTEGER,
      updated_at INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_posts_user_id ON ps_posts (user_id);
    CREATE INDEX IF NOT EXISTS idx_ps_posts_created_at ON ps_posts (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ps_posts_story ON ps_posts (story, story_expires_at);
    CREATE TABLE IF NOT EXISTS ps_notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      from_user_id TEXT,
      kind TEXT,
      created_at INTEGER NOT NULL,
      seen_at INTEGER,
      updated_at INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_notifications_user_created ON ps_notifications (user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS ps_dm_index (
      owner_user_id TEXT NOT NULL,
      peer_user_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      from_me INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      PRIMARY KEY (owner_user_id, peer_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ps_dm_index_owner_created ON ps_dm_index (owner_user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS ps_messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER,
      disappear_at INTEGER,
      updated_at INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_messages_room_created ON ps_messages (room_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS ps_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ps_user_feeds (
      user_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, post_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ps_user_feeds_user_created ON ps_user_feeds (user_id, created_at DESC);
  `);
  _tursoReady = true;
  return true;
}
__name(tursoEnsure, "tursoEnsure");
async function tursoReadDb() {
  if (!isTursoConfigured()) return null;
  await tursoEnsure();
  const rs = await tursoClient().execute({ sql: "SELECT value FROM ps_kv WHERE key = ? LIMIT 1", args: ["db"] });
  if (!rs.rows || rs.rows.length === 0) return normalizeDb({});
  return normalizeDb(safeJson(String(rs.rows[0].value || "{}"), normalizeDb({})));
}
__name(tursoReadDb, "tursoReadDb");
async function tursoReadDbVersioned() {
  if (!isTursoConfigured()) return null;
  await tursoEnsure();
  const rs = await tursoClient().execute({ sql: "SELECT value, version FROM ps_kv WHERE key = ? LIMIT 1", args: ["db"] });
  if (!rs.rows || rs.rows.length === 0) return { db: normalizeDb({}), version: null };
  return { db: normalizeDb(safeJson(String(rs.rows[0].value || "{}"), normalizeDb({}))), version: Number(rs.rows[0].version || 0) };
}
__name(tursoReadDbVersioned, "tursoReadDbVersioned");
async function tursoWriteDb(dbObj) {
  if (!isTursoConfigured()) return false;
  await tursoEnsure();
  const db2 = normalizeDb(dbObj);
  db2.meta = { ...db2.meta || {}, storage: "turso-json-v1", updatedAt: Date.now() };
  const ts = nowMs();
  await tursoClient().execute({
    sql: `INSERT INTO ps_kv (key, value, version, updated_at) VALUES (?, ?, 1, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = ps_kv.version + 1, updated_at = excluded.updated_at`,
    args: ["db", JSON.stringify(db2), ts]
  });
  return true;
}
__name(tursoWriteDb, "tursoWriteDb");
async function tursoWriteDbCAS(dbObj, expectedVersion) {
  if (!isTursoConfigured()) return false;
  await tursoEnsure();
  const db2 = normalizeDb(dbObj);
  db2.meta = { ...db2.meta || {}, storage: "turso-json-v1", updatedAt: Date.now() };
  const ts = nowMs();
  if (expectedVersion === null || expectedVersion === void 0) {
    const rs2 = await tursoClient().execute({
      sql: "INSERT INTO ps_kv (key, value, version, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(key) DO NOTHING",
      args: ["db", JSON.stringify(db2), ts]
    });
    return Number(rs2.rowsAffected || 0) > 0;
  }
  const rs = await tursoClient().execute({
    sql: "UPDATE ps_kv SET value = ?, version = version + 1, updated_at = ? WHERE key = ? AND version = ?",
    args: [JSON.stringify(db2), ts, "db", Number(expectedVersion || 0)]
  });
  return Number(rs.rowsAffected || 0) > 0;
}
__name(tursoWriteDbCAS, "tursoWriteDbCAS");
async function syncTursoMirror(db2) {
  if (!isTursoConfigured()) return false;
  await tursoEnsure();
  const c = tursoClient();
  const src = normalizeDb(db2);
  const ts = nowMs();
  try {
    const statements = [{ sql: "DELETE FROM ps_users" }];
    for (const u of src.users || []) {
      statements.push({
        sql: "INSERT INTO ps_users (id, username_lower, email_lower, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?)",
        args: [u.id, String(u.username || "").toLowerCase(), String(u.email || "").toLowerCase(), Number(u.createdAt || 0), ts, JSON.stringify(u)]
      });
    }
    statements.push({ sql: "DELETE FROM ps_posts" });
    for (const p of src.posts || []) {
      statements.push({
        sql: "INSERT INTO ps_posts (id, user_id, created_at, deleted_at, story, story_expires_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        args: [p.id, p.userId, Number(p.createdAt || 0), p.deletedAt ? Number(p.deletedAt) : null, p.story ? 1 : 0, p.storyExpiresAt ? Number(p.storyExpiresAt) : null, ts, JSON.stringify(p)]
      });
    }
    statements.push({ sql: "DELETE FROM ps_notifications" });
    for (const n of src.notifications || []) {
      statements.push({
        sql: "INSERT INTO ps_notifications (id, user_id, from_user_id, kind, created_at, seen_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        args: [n.id, n.userId, n.fromUserId || null, n.kind || null, Number(n.createdAt || 0), n.seenAt ? Number(n.seenAt) : null, ts, JSON.stringify(n)]
      });
    }
    const dmIndex = /* @__PURE__ */ new Map();
    for (const m of src.messages || []) {
      if (!m || m.deletedAt || typeof m.roomId !== "string" || !m.roomId.startsWith("dm:")) continue;
      const parts = m.roomId.slice(3).split(":").filter(Boolean);
      if (parts.length !== 2) continue;
      for (const ownerId of parts) {
        const peerId = parts.find((id) => id !== ownerId);
        if (!peerId) continue;
        const key = ownerId + "|" + peerId;
        const prev = dmIndex.get(key);
        if (prev && Number(prev.createdAt || 0) >= Number(m.createdAt || 0)) continue;
        let preview;
        if (m.encrypted) preview = "\u{1F512} Encrypted message";
        else if (m.storyReply) preview = "Replied to a story";
        else if (m.imageUrl) preview = "\u{1F4F7} Photo";
        else preview = String(m.text || "").slice(0, 60);
        dmIndex.set(key, {
          ownerUserId: ownerId,
          peerUserId: peerId,
          roomId: m.roomId,
          messageId: m.id,
          createdAt: Number(m.createdAt || 0),
          fromMe: m.userId === ownerId,
          text: preview
        });
      }
    }
    statements.push({ sql: "DELETE FROM ps_dm_index" });
    for (const row of dmIndex.values()) {
      statements.push({
        sql: "INSERT INTO ps_dm_index (owner_user_id, peer_user_id, room_id, created_at, from_me, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [row.ownerUserId, row.peerUserId, row.roomId, row.createdAt, row.fromMe ? 1 : 0, ts, JSON.stringify(row)]
      });
    }
    statements.push({ sql: "DELETE FROM ps_messages" });
    for (const m of src.messages || []) {
      statements.push({
        sql: "INSERT INTO ps_messages (id, room_id, user_id, created_at, deleted_at, disappear_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        args: [m.id, m.roomId || "general-group", m.userId || "", Number(m.createdAt || 0), m.deletedAt ? Number(m.deletedAt) : null, m.disappearAt ? Number(m.disappearAt) : null, ts, JSON.stringify(m)]
      });
    }
    statements.push({
      sql: "INSERT INTO ps_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      args: ["bootstrap_v1", String(ts), ts]
    });
    await c.batch(statements, "write");
    _tursoBootstrapped = true;
    return true;
  } catch (e) {
    console.warn("[turso] sync failed", e && e.message);
    return false;
  }
}
__name(syncTursoMirror, "syncTursoMirror");
async function fetchTursoMirror(fallbackDb = null) {
  if (!isTursoConfigured()) return fallbackDb ? normalizeDb(fallbackDb) : normalizeDb({});
  try {
    await tursoEnsure();
    const c = tursoClient();
    if (!_tursoBootstrapped) {
      const meta = await c.execute({ sql: "SELECT value FROM ps_meta WHERE key = ?", args: ["bootstrap_v1"] }).catch(() => ({ rows: [] }));
      if (!meta.rows || meta.rows.length === 0) {
        if (fallbackDb) await syncTursoMirror(fallbackDb);
      } else {
        _tursoBootstrapped = true;
      }
    }
    let usersRows = await c.execute("SELECT data_json FROM ps_users ORDER BY created_at ASC");
    let postsRows = await c.execute("SELECT data_json FROM ps_posts ORDER BY created_at DESC");
    if (!usersRows.rows?.length && !postsRows.rows?.length && fallbackDb) {
      await syncTursoMirror(fallbackDb);
      usersRows = await c.execute("SELECT data_json FROM ps_users ORDER BY created_at ASC");
      postsRows = await c.execute("SELECT data_json FROM ps_posts ORDER BY created_at DESC");
    }
    return normalizeDb({
      users: (usersRows.rows || []).map((r) => safeJson(String(r.data_json || "{}"), null)).filter(Boolean),
      posts: (postsRows.rows || []).map((r) => safeJson(String(r.data_json || "{}"), null)).filter(Boolean)
    });
  } catch (e) {
    console.warn("[turso] mirror read failed", e && e.message);
    return fallbackDb ? normalizeDb(fallbackDb) : normalizeDb({});
  }
}
__name(fetchTursoMirror, "fetchTursoMirror");
async function fetchTursoNotifications(userId) {
  if (!isTursoConfigured() || !userId) return [];
  await tursoEnsure();
  const rs = await tursoClient().execute({ sql: "SELECT data_json FROM ps_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 200", args: [userId] }).catch(() => ({ rows: [] }));
  return (rs.rows || []).map((r) => safeJson(String(r.data_json || "{}"), null)).filter(Boolean);
}
__name(fetchTursoNotifications, "fetchTursoNotifications");
async function fetchTursoDmIndex(ownerUserId) {
  if (!isTursoConfigured() || !ownerUserId) return {};
  await tursoEnsure();
  const rs = await tursoClient().execute({ sql: "SELECT data_json FROM ps_dm_index WHERE owner_user_id = ? ORDER BY created_at DESC", args: [ownerUserId] }).catch(() => ({ rows: [] }));
  const out = {};
  for (const row of rs.rows || []) {
    const item = safeJson(String(row.data_json || "{}"), null);
    if (item && item.peerUserId) out[item.peerUserId] = { text: item.text || "", createdAt: Number(item.createdAt || 0), fromMe: !!item.fromMe };
  }
  return out;
}
__name(fetchTursoDmIndex, "fetchTursoDmIndex");
async function fetchTursoMessages(roomId, now = nowMs()) {
  if (!isTursoConfigured() || !roomId) return null;
  try {
    await tursoEnsure();
    const rs = await tursoClient().execute({
      sql: "SELECT data_json FROM ps_messages WHERE room_id = ? AND (deleted_at IS NULL OR deleted_at = 0) AND (disappear_at IS NULL OR disappear_at > ?) ORDER BY created_at DESC LIMIT 200",
      args: [roomId, Number(now || 0)]
    });
    const list = (rs.rows || []).map((r) => safeJson(String(r.data_json || "{}"), null)).filter(Boolean);
    return list.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  } catch (e) {
    console.warn("[turso] messages read failed", e && e.message);
    return null;
  }
}
__name(fetchTursoMessages, "fetchTursoMessages");
async function tursoUpsertUser(user) {
  if (!isTursoConfigured() || !user) return false;
  await tursoEnsure();
  const ts = nowMs();
  try {
    await tursoClient().execute({
      sql: "INSERT INTO ps_users (id, username_lower, email_lower, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username_lower=excluded.username_lower, email_lower=excluded.email_lower, updated_at=excluded.updated_at, data_json=excluded.data_json",
      args: [user.id, String(user.username || "").toLowerCase(), String(user.email || "").toLowerCase(), Number(user.createdAt || 0), ts, JSON.stringify(user)]
    });
    return true;
  } catch (e) {
    console.warn("[turso] user upsert failed", e && e.message);
    return false;
  }
}
__name(tursoUpsertUser, "tursoUpsertUser");
async function tursoUpsertPosts(posts) {
  if (!isTursoConfigured()) return false;
  const list = (posts || []).filter(Boolean);
  if (!list.length) return true;
  await tursoEnsure();
  const ts = nowMs();
  const stmts = list.map((p) => ({
    sql: "INSERT INTO ps_posts (id, user_id, created_at, deleted_at, story, story_expires_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, created_at=excluded.created_at, deleted_at=excluded.deleted_at, story=excluded.story, story_expires_at=excluded.story_expires_at, updated_at=excluded.updated_at, data_json=excluded.data_json",
    args: [p.id, p.userId, Number(p.createdAt || 0), p.deletedAt ? Number(p.deletedAt) : null, p.story ? 1 : 0, p.storyExpiresAt ? Number(p.storyExpiresAt) : null, ts, JSON.stringify(p)]
  }));
  await tursoClient().batch(stmts, "write").catch((e) => {
    console.warn("[turso] post upsert failed", e && e.message);
  });
  return true;
}
__name(tursoUpsertPosts, "tursoUpsertPosts");
async function tursoUpsertNotifications(notifs) {
  if (!isTursoConfigured()) return false;
  const list = (notifs || []).filter(Boolean);
  if (!list.length) return true;
  await tursoEnsure();
  const ts = nowMs();
  const stmts = list.map((n) => ({
    sql: "INSERT INTO ps_notifications (id, user_id, from_user_id, kind, created_at, seen_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, from_user_id=excluded.from_user_id, kind=excluded.kind, created_at=excluded.created_at, seen_at=excluded.seen_at, updated_at=excluded.updated_at, data_json=excluded.data_json",
    args: [n.id, n.userId, n.fromUserId || null, n.kind || null, Number(n.createdAt || 0), n.seenAt ? Number(n.seenAt) : null, ts, JSON.stringify(n)]
  }));
  await tursoClient().batch(stmts, "write").catch((e) => {
    console.warn("[turso] notification upsert failed", e && e.message);
  });
  return true;
}
__name(tursoUpsertNotifications, "tursoUpsertNotifications");
async function tursoClearNotificationsForUser(userId) {
  if (!isTursoConfigured() || !userId) return false;
  await tursoEnsure();
  await tursoClient().execute({ sql: "DELETE FROM ps_notifications WHERE user_id = ?", args: [userId] }).catch((e) => {
    console.warn("[turso] notification clear failed", e && e.message);
  });
  return true;
}
__name(tursoClearNotificationsForUser, "tursoClearNotificationsForUser");
async function tursoUpsertMessages(messages) {
  if (!isTursoConfigured()) return false;
  const list = (messages || []).filter(Boolean);
  if (!list.length) return true;
  await tursoEnsure();
  const ts = nowMs();
  const stmts = list.map((m) => ({
    sql: "INSERT INTO ps_messages (id, room_id, user_id, created_at, deleted_at, disappear_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET room_id=excluded.room_id, user_id=excluded.user_id, created_at=excluded.created_at, deleted_at=excluded.deleted_at, disappear_at=excluded.disappear_at, updated_at=excluded.updated_at, data_json=excluded.data_json",
    args: [m.id, m.roomId || "general-group", m.userId || "", Number(m.createdAt || 0), m.deletedAt ? Number(m.deletedAt) : null, m.disappearAt ? Number(m.disappearAt) : null, ts, JSON.stringify(m)]
  }));
  await tursoClient().batch(stmts, "write").catch((e) => {
    console.warn("[turso] message upsert failed", e && e.message);
  });
  return true;
}
__name(tursoUpsertMessages, "tursoUpsertMessages");
async function tursoRefreshDmIndexForOwners(db2, ownerIds) {
  if (!isTursoConfigured()) return false;
  const owners = Array.from(new Set((ownerIds || []).filter(Boolean)));
  if (!owners.length) return true;
  await tursoEnsure();
  const ts = nowMs();
  const stmts = [];
  for (const ownerId of owners) {
    stmts.push({ sql: "DELETE FROM ps_dm_index WHERE owner_user_id = ?", args: [ownerId] });
    const dmIndex = /* @__PURE__ */ new Map();
    for (const m of db2.messages || []) {
      if (!m || m.deletedAt || typeof m.roomId !== "string" || !m.roomId.startsWith("dm:")) continue;
      const parts = m.roomId.slice(3).split(":").filter(Boolean);
      if (!parts.includes(ownerId) || parts.length !== 2) continue;
      const peerId = parts.find((id) => id !== ownerId);
      if (!peerId) continue;
      const prev = dmIndex.get(peerId);
      if (prev && Number(prev.createdAt || 0) >= Number(m.createdAt || 0)) continue;
      let preview;
      if (m.encrypted) preview = "\u{1F512} Encrypted message";
      else if (m.storyReply) preview = "Replied to a story";
      else if (m.imageUrl) preview = "\u{1F4F7} Photo";
      else preview = String(m.text || "").slice(0, 60);
      dmIndex.set(peerId, {
        ownerUserId: ownerId,
        peerUserId: peerId,
        roomId: m.roomId,
        createdAt: Number(m.createdAt || 0),
        fromMe: m.userId === ownerId,
        text: preview
      });
    }
    for (const row of dmIndex.values()) {
      stmts.push({
        sql: "INSERT INTO ps_dm_index (owner_user_id, peer_user_id, room_id, created_at, from_me, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [row.ownerUserId, row.peerUserId, row.roomId, row.createdAt, row.fromMe ? 1 : 0, ts, JSON.stringify(row)]
      });
    }
  }
  if (stmts.length) await tursoClient().batch(stmts, "write").catch((e) => {
    console.warn("[turso] dm index refresh failed", e && e.message);
  });
  return true;
}
__name(tursoRefreshDmIndexForOwners, "tursoRefreshDmIndexForOwners");
async function ensureOwnerAccount(db2) {
  return false;
}
__name(ensureOwnerAccount, "ensureOwnerAccount");
async function fetchPrimaryDatabase() {
  if (isTursoConfigured() && isTursoPrimary()) {
    try {
      const tu = tursoClient();
      const batchRs = await tu.batch([
        { sql: "SELECT data_json FROM ps_users" },
        { sql: "SELECT data_json FROM ps_posts" }
      ], "read");
      const uRows = batchRs[0] && batchRs[0].rows || [];
      const pRows = batchRs[1] && batchRs[1].rows || [];
      const users = uRows.map((r) => safeJson(String(r.data_json || ""), null)).filter(Boolean);
      const posts = pRows.map((r) => safeJson(String(r.data_json || ""), null)).filter(Boolean);
      if (users.length > 0 || posts.length > 0) {
        return normalizeDb({ ...localCache || {}, users, posts });
      }
    } catch (e) {
      console.warn("[fetchPrimary] structured read failed, falling back:", e && e.message);
    }
  }
  const remote = await repoRead();
  if (remote && typeof remote === "object" && !remote._httpError && !remote._err) {
    return normalizeDb(remote);
  }
  return normalizeDb(localCache);
}
__name(fetchPrimaryDatabase, "fetchPrimaryDatabase");
async function fetchDatabase({ fresh = false, includeTurso = true } = {}) {
  if (!includeTurso) fresh = true;
  const now = nowMs();
  if (!fresh && now - cacheTimestamp < CACHE_TTL_MS && cacheTimestamp !== 0) {
    runScheduler(localCache);
    return localCache;
  }
  const remote = await repoRead();
  if (remote && typeof remote === "object" && !remote._httpError && !remote._err) {
    localCache = normalizeDb(remote);
  }
  if (includeTurso && isTursoConfigured()) {
    try {
      const tu = tursoClient();
      const batchRs = await tu.batch([
        { sql: "SELECT data_json FROM ps_users" },
        { sql: "SELECT data_json FROM ps_posts" }
      ], "read");
      const uRows = batchRs[0] && batchRs[0].rows || [];
      const pRows = batchRs[1] && batchRs[1].rows || [];
      const users = uRows.map((r) => safeJson(String(r.data_json || ""), null)).filter(Boolean);
      const posts = pRows.map((r) => safeJson(String(r.data_json || ""), null)).filter(Boolean);
      if (users.length > 0) localCache.users = users;
      if (posts.length > 0) localCache.posts = posts;
      localCache.meta = { ...localCache.meta || {}, secondaryPersistence: "turso-structured" };
    } catch (e) {
      console.warn("[fetchDatabase] structured-merge failed, falling back to mirror:", e && e.message);
      const mirror = await fetchTursoMirror(localCache);
      if ((mirror.users || []).length > 0) localCache.users = mirror.users;
      if ((mirror.posts || []).length > 0) localCache.posts = mirror.posts;
    }
  }
  const ownerSeeded = await ensureOwnerAccount(localCache);
  cacheTimestamp = now;
  const changed = runScheduler(localCache) || ownerSeeded;
  if (changed) await saveDatabase(localCache, false);
  return localCache;
}
__name(fetchDatabase, "fetchDatabase");
async function saveDatabase(data, isEphemeral = false, opts = {}) {
  localCache = data;
  cacheTimestamp = nowMs();
  if (!isPersist()) return true;
  if (isEphemeral && !isTursoPrimary()) {
    const now = nowMs();
    if (now - lastEphemeralWrite < EPHEMERAL_WRITE_INTERVAL_MS) return true;
    lastEphemeralWrite = now;
    repoWrite(data).catch(() => {
    });
    return true;
  }
  if (isEphemeral && isTursoPrimary()) {
    try {
      const versioned = await tursoReadDbVersioned();
      const merged = mergeDatabase(versioned.db, data);
      await tursoWriteDbCAS(merged, versioned.version);
    } catch (_) {
    }
    return true;
  }
  if (isTursoPrimary()) {
    const originalData = data;
    const MAX_CAS_ATTEMPTS = 15;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      let versioned;
      try {
        versioned = await tursoReadDbVersioned();
      } catch (e) {
        console.error("[saveDatabase:turso] read failed", e && e.message);
        return false;
      }
      const merged = mergeDatabase(versioned.db, originalData);
      let ok2 = false;
      try {
        ok2 = await tursoWriteDbCAS(merged, versioned.version);
      } catch (e) {
        console.error("[saveDatabase:turso] CAS write failed", e && e.message);
        return false;
      }
      if (ok2) {
        localCache = normalizeDb(merged);
        cacheTimestamp = nowMs();
        return true;
      }
      if (attempt < MAX_CAS_ATTEMPTS - 1) {
        await sleepMs(10 + Math.floor(Math.random() * (20 + attempt * 10)));
      }
    }
    console.error("[saveDatabase:turso] CAS retries exhausted for key=db");
    return false;
  }
  let toWrite = data;
  const remoteBeforeWrite = await repoRead();
  if (remoteBeforeWrite && typeof remoteBeforeWrite === "object" && !remoteBeforeWrite._httpError && !remoteBeforeWrite._err) {
    toWrite = mergeDatabase(remoteBeforeWrite, data);
  }
  let ok = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await sleepMs(250 + attempt * 350);
      ghFileSha = null;
      const latest = await repoRead();
      if (latest && typeof latest === "object" && !latest._httpError && !latest._err) {
        toWrite = mergeDatabase(latest, toWrite);
      }
    }
    ok = await repoWrite(toWrite);
    if (ok) break;
  }
  if (ok) {
    localCache = normalizeDb(toWrite);
    cacheTimestamp = nowMs();
  }
  return ok;
}
__name(saveDatabase, "saveDatabase");
async function saveDatabaseVerified(data, verifyFn, attempts = 4, opts = {}) {
  if (isTursoPrimary()) {
    return await saveDatabase(data, false, opts);
  }
  for (let i = 0; i < attempts; i++) {
    const ok = await saveDatabase(data, false, opts);
    if (ok) {
      await sleepMs(300 + i * 350);
      cacheTimestamp = 0;
      const fresh = await repoRead();
      if (fresh && typeof fresh === "object" && !fresh._httpError && !fresh._err && (!verifyFn || verifyFn(normalizeDb(fresh)))) {
        localCache = normalizeDb(fresh);
        cacheTimestamp = nowMs();
        return true;
      }
      if (fresh && typeof fresh === "object" && !fresh._httpError && !fresh._err) data = mergeDatabase(fresh, data);
    }
    await sleepMs(500 + i * 500);
  }
  return false;
}
__name(saveDatabaseVerified, "saveDatabaseVerified");
async function hmacSha256(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
__name(hmacSha256, "hmacSha256");
function b64url(buf) {
  let s = "";
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
__name(b64url, "b64url");
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return atob(str);
}
__name(b64urlDecode, "b64urlDecode");
function b64urlJson(obj) {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}
__name(b64urlJson, "b64urlJson");
async function signToken(user) {
  const header = { alg: "HS256", typ: "JWT" };
  const iat = Math.floor(Date.now() / 1e3);
  const exp = iat + JWT_EXPIRES_DAYS * 24 * 3600;
  const payload = { uid: user.id, username: user.username, sv: Number(user.tokenVersion || 0), iat, exp };
  const head = b64urlJson(header);
  const body = b64urlJson(payload);
  const sig = b64url(await hmacSha256(JWT_SECRET, head + "." + body));
  return head + "." + body + "." + sig;
}
__name(signToken, "signToken");
async function verifyToken(token) {
  if (!token || typeof token !== "string") throw new Error("No token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Bad token");
  const [head, body, sig] = parts;
  const expected = b64url(await hmacSha256(JWT_SECRET, head + "." + body));
  if (expected !== sig) throw new Error("Bad signature");
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(body));
  } catch (_) {
    throw new Error("Bad payload");
  }
  if (payload.exp && Math.floor(Date.now() / 1e3) > payload.exp) throw new Error("Expired");
  return payload;
}
__name(verifyToken, "verifyToken");
async function authFromRequest(c) {
  const auth = c.req.header("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  try {
    return await verifyToken(token);
  } catch (_) {
    return null;
  }
}
__name(authFromRequest, "authFromRequest");
var _authUserCache = /* @__PURE__ */ new Map();
var _AUTH_CACHE_TTL_MS = 3e4;
async function requireAuth(c, next) {
  const p = await authFromRequest(c);
  if (!p || !p.uid) return c.json({ error: "Missing or invalid token" }, 401);
  const cached = _authUserCache.get(p.uid);
  if (cached && Date.now() - cached.fetchedAt < _AUTH_CACHE_TTL_MS) {
    if (Number(p.sv || 0) !== Number(cached.user.tokenVersion || 0)) {
      return c.json({ error: "Session expired. Please sign in again." }, 401);
    }
    c.set("userId", p.uid);
    c.set("username", cached.user.username || p.username);
    c.set("authUser", cached.user);
    await next();
    return;
  }
  let authDb = await fetchPrimaryDatabase();
  let u = (authDb.users || []).find((x) => x.id === p.uid);
  if (!u) return c.json({ error: "Missing or invalid token" }, 401);
  const tokenVersion = Number(p.sv || 0);
  let userVersion = Number(u.tokenVersion || 0);
  if (tokenVersion !== userVersion) {
    cacheTimestamp = 0;
    authDb = await fetchPrimaryDatabase();
    u = (authDb.users || []).find((x) => x.id === p.uid) || u;
    userVersion = Number(u.tokenVersion || 0);
    if (tokenVersion !== userVersion) return c.json({ error: "Session expired. Please sign in again." }, 401);
  }
  _authUserCache.set(p.uid, { user: u, fetchedAt: Date.now() });
  c.set("userId", p.uid);
  c.set("username", u.username || p.username);
  c.set("authUser", u);
  await next();
}
__name(requireAuth, "requireAuth");
var _rateBuckets = /* @__PURE__ */ new Map();
function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  let b = _rateBuckets.get(key);
  if (!b || b.resetAt < now) {
    b = { count: 0, resetAt: now + windowMs };
    _rateBuckets.set(key, b);
  }
  b.count++;
  return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count), resetAt: b.resetAt };
}
__name(rateLimit, "rateLimit");
async function sharedRateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  const nextResetAt = now + windowMs;
  if (isTursoPrimary()) {
    try {
      await tursoEnsure();
      const tc = tursoClient();
      await tc.execute({
        sql: `INSERT INTO ps_rate_limits (key, count, reset_at, updated_at) VALUES (?, 1, ?, ?)
              ON CONFLICT(key) DO UPDATE SET
                count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
                reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END,
                updated_at = ?`,
        args: [key, nextResetAt, now, now, now, nextResetAt, now]
      });
      if (Math.random() < 0.01) {
        tc.execute({ sql: "DELETE FROM ps_rate_limits WHERE reset_at < ?", args: [now - 24 * 60 * 60 * 1e3] }).catch(() => {
        });
      }
      const rs = await tc.execute({ sql: "SELECT count, reset_at FROM ps_rate_limits WHERE key = ? LIMIT 1", args: [key] });
      const row = rs.rows && rs.rows[0] ? rs.rows[0] : { count: 1, reset_at: nextResetAt };
      const count = Number(row.count || 0);
      const resetAt = Number(row.reset_at || nextResetAt);
      return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt };
    } catch (e) {
      console.warn("[sharedRateLimit:turso] falling back to in-memory limiter:", e && e.message);
      return rateLimit({ key, limit, windowMs });
    }
  }
  return rateLimit({ key, limit, windowMs });
}
__name(sharedRateLimit, "sharedRateLimit");
function clientIp(c) {
  return c.req.header("cf-connecting-ip") || (c.req.header("x-forwarded-for") || "").split(",")[0].trim() || c.req.header("x-real-ip") || "0.0.0.0";
}
__name(clientIp, "clientIp");
async function authRateLimit(c, next) {
  const ip = clientIp(c);
  const r = await sharedRateLimit({ key: "auth:" + ip + ":" + c.req.path, limit: 40, windowMs: 15 * 6e4 });
  if (!r.allowed) {
    c.header("Retry-After", String(Math.ceil((r.resetAt - Date.now()) / 1e3)));
    return c.json({ error: "Too many auth attempts. Try again in 15 minutes." }, 429);
  }
  await next();
}
__name(authRateLimit, "authRateLimit");
async function globalRateLimit(c, next) {
  const ip = clientIp(c);
  const r = rateLimit({ key: "global:" + ip, limit: 400, windowMs: 6e4 });
  c.header("X-RateLimit-Limit", "400");
  c.header("X-RateLimit-Remaining", String(r.remaining));
  if (!r.allowed) {
    c.header("Retry-After", String(Math.ceil((r.resetAt - Date.now()) / 1e3)));
    return c.json({ error: "Too many requests. Please slow down." }, 429);
  }
  await next();
}
__name(globalRateLimit, "globalRateLimit");
var _loginFails = /* @__PURE__ */ new Map();
function checkAccountLock(userId) {
  const rec = _loginFails.get(userId);
  if (!rec) return { locked: false };
  const now = Date.now();
  if (rec.lockedUntil && rec.lockedUntil > now) return { locked: true, remaining: rec.lockedUntil - now };
  return { locked: false };
}
__name(checkAccountLock, "checkAccountLock");
function recordLoginFail(userId) {
  const now = Date.now();
  let rec = _loginFails.get(userId);
  if (!rec || now - rec.firstAt > 5 * 6e4) {
    rec = { count: 0, firstAt: now };
    _loginFails.set(userId, rec);
  }
  rec.count++;
  if (rec.count >= 5) rec.lockedUntil = now + 15 * 6e4;
}
__name(recordLoginFail, "recordLoginFail");
function clearLoginFails(userId) {
  _loginFails.delete(userId);
}
__name(clearLoginFails, "clearLoginFails");
var AUTH_GENERIC_ERROR = "Invalid username/email or password.";
async function authFailureDelay() {
  await sleepMs(250 + Math.floor(Math.random() * 250));
}
__name(authFailureDelay, "authFailureDelay");
async function authSubjectRateLimit(c, subject, limit = 10) {
  const ip = clientIp(c);
  const key = "credential:" + ip + ":" + (subject || "unknown");
  return sharedRateLimit({ key, limit, windowMs: 15 * 6e4 });
}
__name(authSubjectRateLimit, "authSubjectRateLimit");
var _eventQueues = /* @__PURE__ */ new Map();
var _eventSubscribers = /* @__PURE__ */ new Map();
function _pushEvent(userId, kind, data) {
  if (!userId) return;
  const evt = { id: "evt_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7), ts: Date.now(), kind, data };
  if (!_eventQueues.has(userId)) _eventQueues.set(userId, []);
  const q = _eventQueues.get(userId);
  q.push(evt);
  if (q.length > 200) q.splice(0, q.length - 200);
  const subs = _eventSubscribers.get(userId);
  if (subs) for (const sub of subs) {
    if (sub.closed) continue;
    try {
      sub.write(`id: ${evt.id}
event: ${evt.kind}
data: ${JSON.stringify(evt)}

`);
    } catch (_) {
      sub.closed = true;
    }
  }
  if (isTursoPrimary()) {
    tursoEnsure().then(() => tursoClient().execute({
      sql: "INSERT INTO ps_events (id, user_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
      args: [evt.id, userId, kind, JSON.stringify(evt), evt.ts]
    })).catch(() => {
    });
  }
  return evt;
}
__name(_pushEvent, "_pushEvent");
function _broadcastEvent(kind, data, excludeUserId) {
  for (const userId of /* @__PURE__ */ new Set([..._eventSubscribers.keys(), ..._eventQueues.keys()])) {
    if (userId === excludeUserId) continue;
    _pushEvent(userId, kind, data);
  }
  if (isTursoPrimary()) {
    _pushEvent("__ALL__", kind, data);
  }
}
__name(_broadcastEvent, "_broadcastEvent");
function pushNotification(db2, recipientId, kind, fromUserId, extra = {}) {
  if (!recipientId || !fromUserId || recipientId === fromUserId) return null;
  if (!Array.isArray(db2.notifications)) db2.notifications = [];
  const recipient = db2.users.find((u) => u.id === recipientId);
  if (recipient && Array.isArray(recipient.blocked) && recipient.blocked.includes(fromUserId)) return null;
  const now = nowMs();
  const dupe = db2.notifications.find(
    (n) => n.userId === recipientId && n.kind === kind && n.fromUserId === fromUserId && n.postId === (extra.postId || null) && now - n.createdAt < 3e4
  );
  if (dupe) {
    dupe.createdAt = now;
    delete dupe.seenAt;
    return dupe;
  }
  const author = db2.users.find((u) => u.id === fromUserId);
  const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || "" } : null;
  const notif = {
    id: uid("ntf"),
    userId: recipientId,
    kind,
    fromUserId,
    fromSnapshot: snap,
    postId: extra.postId || null,
    commentId: extra.commentId || null,
    text: extra.text || null,
    createdAt: now
  };
  db2.notifications.push(notif);
  const perUser = db2.notifications.filter((n) => n.userId === recipientId);
  if (perUser.length > 500) {
    const oldest = perUser.slice(0, perUser.length - 500).map((n) => n.id);
    db2.notifications = db2.notifications.filter((n) => !oldest.includes(n.id));
  }
  _pushEvent(recipientId, "notification", { kind, fromUserId, fromSnapshot: snap, postId: notif.postId, text: notif.text, notifId: notif.id });
  const fromName = snap && (snap.username || snap.displayName) || "Someone";
  let title = "PRIV SPACA", body = "";
  if (kind === "like") body = `${fromName} liked your post`;
  if (kind === "comment") body = `${fromName} commented: ${(notif.text || "").slice(0, 80)}`;
  if (kind === "follow") body = `${fromName} started following you`;
  if (kind === "message") body = `${fromName}: ${(notif.text || "").slice(0, 80)}`;
  if (body) sendWebPush(db2, recipientId, { title, body, tag: "priv-spaca-" + notif.id, url: "/", kind, notifId: notif.id }).catch(() => {
  });
  return notif;
}
__name(pushNotification, "pushNotification");
function _b64urlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(_b64urlEncode, "_b64urlEncode");
function _b64urlDecode(str) {
  str = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
__name(_b64urlDecode, "_b64urlDecode");
function _concatBytes(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
__name(_concatBytes, "_concatBytes");
async function _importVapidKey() {
  const d = _b64urlDecode(VAPID_PRIVATE);
  const pub = _b64urlDecode(VAPID_PUBLIC);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("Bad VAPID public key");
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: _b64urlEncode(d),
    x: _b64urlEncode(pub.slice(1, 33)),
    y: _b64urlEncode(pub.slice(33, 65)),
    ext: true
  };
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
}
__name(_importVapidKey, "_importVapidKey");
async function _signVapidJwt(audience, expSeconds) {
  const header = { typ: "JWT", alg: "ES256" };
  const payload = { aud: audience, exp: expSeconds, sub: VAPID_SUBJECT };
  const enc = new TextEncoder();
  const headerB64 = _b64urlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = _b64urlEncode(enc.encode(JSON.stringify(payload)));
  const data = enc.encode(headerB64 + "." + payloadB64);
  const key = await _importVapidKey();
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
  return headerB64 + "." + payloadB64 + "." + _b64urlEncode(new Uint8Array(sig));
}
__name(_signVapidJwt, "_signVapidJwt");
async function _hkdf(salt, ikm, info, length) {
  const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    baseKey,
    length * 8
  ));
}
__name(_hkdf, "_hkdf");
async function _encryptPushPayload(subscription, payloadBytes) {
  const ua_public = _b64urlDecode(subscription.keys.p256dh);
  const auth_secret = _b64urlDecode(subscription.keys.auth);
  const esKeypair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const esPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", esKeypair.publicKey));
  const uaPubKey = await crypto.subtle.importKey(
    "raw",
    ua_public,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaPubKey },
    esKeypair.privateKey,
    256
  ));
  const enc = new TextEncoder();
  const keyInfo = _concatBytes(
    enc.encode("WebPush: info\0"),
    ua_public,
    esPublicRaw
  );
  const ikm = await _hkdf(auth_secret, sharedSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await _hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await _hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const padded = _concatBytes(payloadBytes, new Uint8Array([2]));
  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    cekKey,
    padded
  ));
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  header[16] = rs >>> 24 & 255;
  header[17] = rs >>> 16 & 255;
  header[18] = rs >>> 8 & 255;
  header[19] = rs & 255;
  header[20] = 65;
  header.set(esPublicRaw, 21);
  return _concatBytes(header, ciphertext);
}
__name(_encryptPushPayload, "_encryptPushPayload");
async function sendWebPush(db2, recipientId, payload) {
  try {
    if (!VAPID_PRIVATE || !VAPID_PUBLIC) return;
    const user = (db2 && db2.users || []).find((u) => u.id === recipientId);
    if (!user || !user.pushSubs || user.pushSubs.length === 0) return;
    const bodyStr = JSON.stringify(payload || {});
    const bodyBytes = new TextEncoder().encode(bodyStr);
    const dead = [];
    await Promise.all(user.pushSubs.map(async (sub) => {
      try {
        if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return;
        const url = new URL(sub.endpoint);
        const audience = url.origin;
        const exp = Math.floor(Date.now() / 1e3) + 12 * 60 * 60;
        const jwt = await _signVapidJwt(audience, exp);
        const cipher = await _encryptPushPayload(sub, bodyBytes);
        const res = await fetch(sub.endpoint, {
          method: "POST",
          headers: {
            "TTL": "86400",
            "Content-Type": "application/octet-stream",
            "Content-Encoding": "aes128gcm",
            "Authorization": `vapid t=${jwt}, k=${VAPID_PUBLIC}`,
            "Urgency": "normal"
          },
          body: cipher
        });
        if (res.status === 404 || res.status === 410) {
          dead.push(sub.endpoint);
        } else if (!res.ok && res.status >= 400) {
          console.warn("[push] non-OK", res.status, sub.endpoint.slice(0, 60));
        }
      } catch (e) {
        console.warn("[push] err", e && e.message);
      }
    }));
    if (dead.length) {
      try {
        const fresh = await fetchDatabase();
        const u = fresh.users.find((x) => x.id === recipientId);
        if (u && u.pushSubs) {
          u.pushSubs = u.pushSubs.filter((s) => !dead.includes(s.endpoint));
          await saveDatabase(fresh, false);
        }
      } catch (_) {
      }
    }
  } catch (e) {
    console.warn("[sendWebPush] outer err", e && e.message);
  }
}
__name(sendWebPush, "sendWebPush");
function normalizeRoomId(roomId, currentUserId) {
  const raw2 = sanitizeText(String(roomId || "general-group"), 160).trim();
  if (!raw2 || raw2 === "general-group") return "general-group";
  if (/^group:[a-zA-Z0-9_-]{1,64}$/.test(raw2)) return raw2;
  if (raw2.startsWith("dm:")) {
    const parts = raw2.slice(3).split(":").filter(Boolean);
    if (parts.length === 2 && parts.every((x) => /^[a-zA-Z0-9_-]{1,96}$/.test(x))) return "dm:" + [...parts].sort().join(":");
  }
  return "general-group";
}
__name(normalizeRoomId, "normalizeRoomId");
function dmRoomFor(a, b) {
  return "dm:" + [a, b].sort().join(":");
}
__name(dmRoomFor, "dmRoomFor");
app.use("*", async (c, next) => {
  loadConfig(c.env);
  applyCors(c);
  if (c.req.method === "OPTIONS") {
    const origin2 = c.req.header("origin") || "";
    return isAllowedCorsOrigin(origin2) ? c.body(null, 204) : c.text("CORS origin denied", 403);
  }
  const origin = c.req.header("origin") || "";
  if (origin && !isAllowedCorsOrigin(origin)) return c.json({ error: "CORS origin denied" }, 403);
  if (isProductionRequest(c) && isDefaultJwtSecret() && c.req.path.startsWith("/api/") && c.req.path !== "/api/health") {
    return c.json({ error: "Server auth secret is not configured" }, 503);
  }
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "SAMEORIGIN");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
  await next();
});
app.use("/api/*", async (c, next) => {
  const method = c.req.method.toUpperCase();
  const len = Number(c.req.header("content-length") || "0");
  if (["POST", "PUT", "PATCH"].includes(method) && len > 16 * 1024 * 1024) {
    return c.json({ error: "Request body too large" }, 413);
  }
  await next();
});
app.use("/api/*", globalRateLimit);
app.get("/api/health", (c) => c.json({
  ok: true,
  name: "PRIV SPACA",
  persistence: primaryPersistenceName(),
  secondaryPersistence: isTursoConfigured() ? "turso-structured-social" : null,
  runtime: "cloudflare-workers",
  time: nowMs(),
  version: "phase2-turso-json-primary"
}));
app.get("/api/diag", requireAdmin, async (c) => {
  const out = {
    persistence: primaryPersistenceName(),
    repoConfigured: isRepo(),
    gistConfigured: false,
    repo: GH_REPO ? "[configured]" : "",
    branch: GH_BRANCH ? "[configured]" : "",
    file: GH_FILE ? "[configured]" : "",
    canRead: false,
    canWrite: false,
    userCount: 0,
    error: null,
    runtime: "cloudflare-workers"
  };
  try {
    const db2 = await repoRead();
    if (db2 && typeof db2 === "object" && !db2._err && !db2._httpError) {
      out.canRead = true;
      out.userCount = (db2.users || []).length;
      out.canWrite = isTursoPrimary() || !!GITHUB_PAT;
    } else if (!isPersist()) {
      out.canRead = true;
      out.canWrite = true;
      out.userCount = (localCache.users || []).length;
    } else out.error = db2 ? db2._err || db2._httpError || "Read returned no data (not an array)" : "Read returned no data";
  } catch (e) {
    out.error = e.message;
  }
  return c.json(out);
});
app.post("/api/auth/signup", authRateLimit, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { email, username, displayName, password, pin, termsAccepted, termsVersion } = body;
    if (!isEmail(email)) return c.json({ error: "Invalid email" }, 400);
    if (!isUsername(username)) return c.json({ error: "Username must be 3-24 chars (letters, numbers, _)" }, 400);
    const cleanDN = sanitizeText(displayName || "", 60).trim();
    if (!cleanDN) return c.json({ error: "Display name required" }, 400);
    if (!password || password.length < 6) return c.json({ error: "Password must be at least 6 characters" }, 400);
    if (password.length > 128) return c.json({ error: "Password too long (max 128)" }, 400);
    if (!isPin(pin)) return c.json({ error: "PIN must be 4 digits" }, 400);
    const weak = /* @__PURE__ */ new Set(["0000", "1111", "2222", "3333", "4444", "5555", "6666", "7777", "8888", "9999", "1234", "4321", "0123", "2580", "1212", "1313", "1010", "0101", "1122", "1221", "2024", "2025", "2026", "2027", "0007", "1357", "2468", "9876", "6789"]);
    if (weak.has(pin)) return c.json({ error: "Please choose a less obvious PIN" }, 400);
    if (termsAccepted !== true) return c.json({ error: "You must accept the Terms & Community Guidelines." }, 400);
    const db2 = await fetchPrimaryDatabase();
    const emailLower = email.toLowerCase();
    const usernameLower = username.toLowerCase();
    if (db2.users.some((u) => u.email.toLowerCase() === emailLower)) return c.json({ error: "Email already registered" }, 409);
    if (db2.users.some((u) => u.username.toLowerCase() === usernameLower)) return c.json({ error: "Username already taken" }, 409);
    const reserved = /* @__PURE__ */ new Set(["admin", "administrator", "priv-spaca", "privspaca", "support", "system", "moderator", "staff", "help", "root"]);
    if (reserved.has(usernameLower)) return c.json({ error: "That username is reserved" }, 403);
    const passwordHash = await import_bcryptjs.default.hash(password, PASSWORD_HASH_ROUNDS);
    const pinHash = await import_bcryptjs.default.hash(pin, PASSWORD_HASH_ROUNDS);
    const newUser = {
      id: uid("usr"),
      email: emailLower,
      username,
      displayName: cleanDN,
      bio: "",
      photoUrl: "",
      passwordHash,
      pinHash,
      tokenVersion: 0,
      followers: [],
      following: [],
      blocked: [],
      closeFriends: [],
      termsAccepted: true,
      termsVersion: String(termsVersion || "1.0"),
      termsAcceptedAt: nowMs(),
      createdAt: nowMs(),
      verified: false
    };
    db2.users.push(newUser);
    const persisted = await saveDatabaseVerified(db2, (d) => (d.users || []).some((u) => u.id === newUser.id));
    if (isPersist() && !persisted) {
      db2.users = db2.users.filter((u) => u.id !== newUser.id);
      return c.json({ error: "Storage temporarily unavailable. Please try again in a moment." }, 503);
    }
    if (isTursoConfigured()) await tursoUpsertUser(newUser);
    const token = await signToken(newUser);
    return c.json({ token, user: sanitizeUser(newUser, true) });
  } catch (e) {
    console.error("[signup]", e);
    return c.json({ error: "Signup failed" }, 500);
  }
});
app.post("/api/auth/login", authRateLimit, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { identifier, password } = body;
    const idLower = normalizeAuthIdentifier(identifier);
    if (!idLower || typeof password !== "string" || password.length < 1 || password.length > 128) {
      await authFailureDelay();
      return c.json({ error: AUTH_GENERIC_ERROR }, 401);
    }
    const subjLimit = await authSubjectRateLimit(c, idLower, 20);
    if (!subjLimit.allowed) {
      c.header("Retry-After", String(Math.ceil((subjLimit.resetAt - Date.now()) / 1e3)));
      return c.json({ error: "Too many login attempts. Please wait and try again." }, 429);
    }
    if (!_loginUserCache) _loginUserCache = /* @__PURE__ */ new Map();
    const userCacheKey = "user:" + idLower;
    let user = _loginUserCache.get(userCacheKey);
    if (user && Date.now() - user._cachedAt < 6e4) {
      user = user._user;
    } else {
      user = null;
      try {
        if (isTursoConfigured()) {
          const turso = tursoClient();
          const r = await turso.execute({
            sql: "SELECT data_json FROM ps_users WHERE username_lower = ? OR email_lower = ? LIMIT 1",
            args: [idLower, idLower]
          });
          if (r.rows && r.rows.length > 0) {
            const parsed = safeJson(String(r.rows[0].data_json || ""), null);
            if (parsed && parsed.id) {
              user = parsed;
              _loginUserCache.set(userCacheKey, { _user: user, _cachedAt: Date.now() });
            }
          }
        }
      } catch (_) {
      }
    }
    if (!user) {
      const db2 = await fetchPrimaryDatabase();
      user = db2.users.find((u) => u.email.toLowerCase() === idLower || u.username.toLowerCase() === idLower);
    }
    if (!user) {
      await authFailureDelay();
      return c.json({ error: AUTH_GENERIC_ERROR }, 404);
    }
    const lock = checkAccountLock(user.id);
    if (lock.locked) {
      c.header("Retry-After", String(Math.ceil(lock.remaining / 1e3)));
      return c.json({ error: "Too many login attempts. Please wait and try again." }, 429);
    }
    let matchUser = user;
    const bcryptCacheKey = matchUser.id + "|" + (matchUser.passwordHash || "").slice(0, 30) + "|" + password;
    let ok = false;
    if (!_bcryptVerifyCache) _bcryptVerifyCache = /* @__PURE__ */ new Map();
    const cached = _bcryptVerifyCache.get(bcryptCacheKey);
    if (cached && Date.now() - cached.ts < 3e5) {
      ok = cached.ok;
    } else {
      ok = await import_bcryptjs.default.compare(password, matchUser.passwordHash);
      _bcryptVerifyCache.set(bcryptCacheKey, { ok, ts: Date.now() });
      if (_bcryptVerifyCache.size > 200) {
        const firstKey = _bcryptVerifyCache.keys().next().value;
        _bcryptVerifyCache.delete(firstKey);
      }
    }
    if (!ok) {
      const freshDb = await fetchPrimaryDatabase();
      const freshUser = freshDb.users.find((u) => u.id === user.id);
      if (freshUser && freshUser.passwordHash !== matchUser.passwordHash) {
        matchUser = freshUser;
        ok = await import_bcryptjs.default.compare(password, matchUser.passwordHash);
      }
    }
    if (!ok) {
      recordLoginFail(user.id);
      await authFailureDelay();
      return c.json({ error: AUTH_GENERIC_ERROR }, 401);
    }
    clearLoginFails(user.id);
    try {
      const m = (matchUser.passwordHash || "").match(/^\$2[aby]\$(\d{2})\$/);
      if (m && Number(m[1]) !== PASSWORD_HASH_ROUNDS) {
        const newHash = await import_bcryptjs.default.hash(password, PASSWORD_HASH_ROUNDS);
        matchUser.passwordHash = newHash;
        matchUser.passwordChangedAt = nowMs();
        const db2 = await fetchPrimaryDatabase();
        const u2 = (db2.users || []).find((x) => x.id === matchUser.id);
        if (u2) {
          u2.passwordHash = newHash;
          u2.passwordChangedAt = matchUser.passwordChangedAt;
          saveDatabase(db2, true, { skipSecondarySync: true }).catch(() => {
          });
          if (isTursoConfigured()) {
            try {
              const tu = tursoClient();
              await tu.batch([
                { sql: "UPDATE ps_users SET data_json = ?, updated_at = ? WHERE id = ?", args: [JSON.stringify(u2), nowMs(), u2.id] }
              ], "write");
            } catch (_) {
            }
          }
        }
      }
    } catch (_) {
    }
    const token = await signToken(matchUser);
    return c.json({ token, user: sanitizeUser(matchUser, true) });
  } catch (e) {
    console.error("[login]", e);
    return c.json({ error: "Login failed" }, 500);
  }
});
app.post("/api/auth/reset-by-pin", authRateLimit, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { identifier, pin, newPassword } = body;
    const idLower = normalizeAuthIdentifier(identifier);
    if (!idLower || !isPin(pin) || typeof newPassword !== "string" || newPassword.length < 6 || newPassword.length > 128) {
      await authFailureDelay();
      return c.json({ error: "Invalid reset details." }, 400);
    }
    const subjLimit = await authSubjectRateLimit(c, "reset:" + idLower, 8);
    if (!subjLimit.allowed) {
      c.header("Retry-After", String(Math.ceil((subjLimit.resetAt - Date.now()) / 1e3)));
      return c.json({ error: "Too many reset attempts. Please wait and try again." }, 429);
    }
    let user = null;
    try {
      if (isTursoConfigured()) {
        const turso = tursoClient();
        const r = await turso.execute({
          sql: "SELECT data_json FROM ps_users WHERE username_lower = ? OR email_lower = ? LIMIT 1",
          args: [idLower, idLower]
        });
        if (r.rows && r.rows.length > 0) {
          const parsed = safeJson(String(r.rows[0].data_json || ""), null);
          if (parsed && parsed.id) user = parsed;
        }
      }
    } catch (_) {
    }
    if (!user) {
      const db2 = await fetchPrimaryDatabase();
      user = db2.users.find((u) => u.email.toLowerCase() === idLower || u.username.toLowerCase() === idLower);
    }
    if (!user) {
      await authFailureDelay();
      return c.json({ error: "Invalid reset details." }, 401);
    }
    const pinOk = await import_bcryptjs.default.compare(pin, user.pinHash);
    if (!pinOk) {
      await authFailureDelay();
      return c.json({ error: "Invalid reset details." }, 401);
    }
    const oldHash = user.passwordHash;
    const oldTokenVersion = Number(user.tokenVersion || 0);
    user.passwordHash = await import_bcryptjs.default.hash(newPassword, PASSWORD_HASH_ROUNDS);
    user.tokenVersion = oldTokenVersion + 1;
    user.passwordChangedAt = nowMs();
    _authUserCache.delete(user.id);
    const persisted = await saveDatabaseVerified(db, (d) => {
      const u2 = (d.users || []).find((u) => u.id === user.id);
      return !!u2 && u2.passwordHash === user.passwordHash && Number(u2.tokenVersion || 0) === user.tokenVersion;
    });
    if (isPersist() && !persisted) {
      user.passwordHash = oldHash;
      user.tokenVersion = oldTokenVersion;
      return c.json({ error: "Storage temporarily unavailable" }, 503);
    }
    if (isTursoConfigured()) await tursoUpsertUser(user);
    const token = await signToken(user);
    return c.json({ ok: true, token, user: sanitizeUser(user, true) });
  } catch (e) {
    console.error("[reset]", e);
    return c.json({ error: "Reset failed" }, 500);
  }
});
app.get("/api/auth/me", requireAuth, async (c) => {
  const u = c.get("authUser");
  if (!u) return c.json({ error: "Not found" }, 404);
  return c.json({ user: sanitizeUser(u, true) });
});
async function sha1Hex(str) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-1", enc.encode(str));
  let s = "";
  for (const b of new Uint8Array(buf)) s += b.toString(16).padStart(2, "0");
  return s;
}
__name(sha1Hex, "sha1Hex");
function isCloudinaryConfigured() {
  return !!(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);
}
__name(isCloudinaryConfigured, "isCloudinaryConfigured");
async function uploadToCloudinary(dataUrl, folder, publicId) {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  const mime = m[1];
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  const timestamp = Math.floor(Date.now() / 1e3);
  const params = {
    folder,
    public_id: publicId,
    timestamp: String(timestamp),
    overwrite: "true"
  };
  const toSign = Object.keys(params).sort().map((k) => k + "=" + params[k]).join("&") + CLOUDINARY_API_SECRET;
  const signature = await sha1Hex(toSign);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), "upload");
  form.append("api_key", CLOUDINARY_API_KEY);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);
  form.append("folder", folder);
  form.append("public_id", publicId);
  form.append("overwrite", "true");
  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/auto/upload`;
  const r = await fetch(url, { method: "POST", body: form });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("[cloudinary]", r.status, t.slice(0, 300));
    return null;
  }
  const j = await r.json();
  return j.secure_url || j.url || null;
}
__name(uploadToCloudinary, "uploadToCloudinary");
app.post("/api/upload-photo", requireAuth, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { dataUrl, kind } = body;
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/") && !dataUrl.startsWith("data:audio/") && !dataUrl.startsWith("data:video/")) {
      return c.json({ error: "Send a data URL: data:image/... , data:audio/... or data:video/..." }, 400);
    }
    const m = dataUrl.match(/^data:(image|audio|video)\/(jpeg|jpg|png|webp|gif|webm|mp3|mp4|quicktime|mov);base64,(.+)$/);
    if (!m) return c.json({ error: "Unsupported media type" }, 400);
    const isVideo = m[1] === "video";
    let ext = m[2] === "jpeg" ? "jpg" : m[2] === "quicktime" ? "mov" : m[2];
    const b64 = m[3];
    const size = Math.floor(b64.length * 3 / 4);
    const maxBytes = isVideo ? 10 * 1024 * 1024 : 5 * 1024 * 1024;
    if (size > maxBytes) return c.json({ error: isVideo ? "Video too large (max 10 MB)" : "Image too large (max 5 MB)" }, 413);
    const userId = c.get("userId");
    const safeKind = kind === "post" || kind === "avatar" ? kind : "media";
    const folder = safeKind === "avatar" ? "avatars" : safeKind === "post" ? "posts" : "media";
    const id = safeKind === "avatar" ? userId : uid(isVideo ? "vid" : "img");
    if (isCloudinaryConfigured()) {
      try {
        const cdn2 = await uploadToCloudinary(dataUrl, `${CLOUDINARY_FOLDER}/${folder}`, id);
        if (cdn2) return c.json({ url: cdn2, persisted: true });
      } catch (e) {
        console.warn("[upload] cloudinary failed, falling back to GitHub:", e && e.message);
      }
    }
    const path = `media/${folder}/${id}.${ext}`;
    if (!isRepo()) return c.json({ url: dataUrl, persisted: false });
    let priorSha = null;
    try {
      const h = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GH_BRANCH)}`, {
        headers: { Authorization: "token " + GITHUB_PAT, "User-Agent": "PRIV-SPACA", Accept: "application/vnd.github+json" }
      });
      if (h.ok) {
        const j = await h.json();
        priorSha = j.sha || null;
      }
    } catch (_) {
    }
    const putBody = { message: `upload ${safeKind} ${id}`, content: b64, branch: GH_BRANCH };
    if (priorSha) putBody.sha = priorSha;
    const put = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { Authorization: "token " + GITHUB_PAT, "User-Agent": "PRIV-SPACA", Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify(putBody)
    });
    if (!put.ok) {
      const t = await put.text().catch(() => "");
      console.error("[upload]", put.status, t.slice(0, 200));
      return c.json({ url: dataUrl, persisted: false, warning: "GitHub upload failed; using inline data URL." });
    }
    const cdn = `https://raw.githubusercontent.com/${GH_REPO}/${encodeURIComponent(GH_BRANCH)}/${path}?t=${Date.now()}`;
    return c.json({ url: cdn, persisted: true });
  } catch (e) {
    console.error("[upload]", e);
    return c.json({ error: "Upload failed" }, 500);
  }
});
app.post("/api/user/update", requireAuth, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { displayName, username, bio, photoUrl, dateOfBirth, cardVisibility } = body;
    const db2 = await fetchDatabase();
    const user = db2.users.find((u) => u.id === c.get("userId"));
    if (!user) return c.json({ error: "Not found" }, 404);
    if (typeof username === "string" && username !== user.username) {
      if (!isUsername(username)) return c.json({ error: "Invalid username" }, 400);
      if (db2.users.some((u) => u.id !== user.id && u.username.toLowerCase() === username.toLowerCase())) return c.json({ error: "Username taken" }, 409);
      user.username = username;
    }
    if (typeof displayName === "string") {
      const dn = sanitizeText(displayName, 60).trim();
      if (dn.length >= 1) user.displayName = dn;
    }
    if (typeof bio === "string") user.bio = sanitizeText(bio, 280);
    if (typeof photoUrl === "string") {
      const cleanPhoto = photoUrl.trim();
      if (cleanPhoto === "" || isSafeImageUrl(cleanPhoto)) user.photoUrl = cleanPhoto;
    }
    if (typeof dateOfBirth === "string") {
      const dob = dateOfBirth.trim();
      if (dob === "" || /^\d{4}-\d{2}-\d{2}$/.test(dob)) user.dateOfBirth = dob;
    }
    if (typeof cardVisibility === "string") {
      const cv = cardVisibility.trim();
      if (["everyone", "close_friends", "private"].includes(cv)) user.cardVisibility = cv;
    }
    await saveDatabase(db2, false);
    if (isTursoConfigured()) await tursoUpsertUser(user);
    return c.json({ user: sanitizeUser(user, true) });
  } catch (e) {
    console.error("[user/update]", e);
    return c.json({ error: "Update failed" }, 500);
  }
});
app.post("/api/user/vip/redeem", requireAuth, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const key = sanitizeText(String(body.key || ""), 80).trim();
    if (!VIP_UNLOCK_KEY) return c.json({ error: "VIP unlock is not configured" }, 503);
    if (!key || key !== VIP_UNLOCK_KEY) return c.json({ error: "Invalid VIP key" }, 403);
    const db2 = await fetchDatabase({ fresh: true });
    const user = db2.users.find((u) => u.id === c.get("userId"));
    if (!user) return c.json({ error: "Not found" }, 404);
    user.verified = true;
    user.verifiedAt = user.verifiedAt || nowMs();
    await saveDatabase(db2, false);
    if (isTursoConfigured()) await tursoUpsertUser(user);
    return c.json({ ok: true, user: sanitizeUser(user, true) });
  } catch (e) {
    console.error("[vip/redeem]", e);
    return c.json({ error: "VIP activation failed" }, 500);
  }
});
app.get("/api/user/close-friends", requireAuth, async (c) => {
  const db2 = await fetchDatabase();
  const me = db2.users.find((u) => u.id === c.get("userId"));
  if (!me) return c.json({ error: "Not found" }, 404);
  const ids = Array.isArray(me.closeFriends) ? me.closeFriends : [];
  return c.json({ ids });
});
app.post("/api/user/close-friends", requireAuth, async (c) => {
  try {
    const { targetId, action } = await c.req.json().catch(() => ({}));
    const myId = c.get("userId");
    if (!targetId) return c.json({ error: "targetId required" }, 400);
    if (targetId === myId) return c.json({ error: "You cannot add yourself" }, 400);
    const db2 = await fetchDatabase();
    const me = db2.users.find((u) => u.id === myId);
    const target = db2.users.find((u) => u.id === targetId);
    if (!me || !target) return c.json({ error: "Not found" }, 404);
    me.closeFriends = Array.isArray(me.closeFriends) ? me.closeFriends : [];
    const set = new Set(me.closeFriends);
    const mode = String(action || "toggle");
    if (mode === "add") set.add(targetId);
    else if (mode === "remove") set.delete(targetId);
    else if (set.has(targetId)) set.delete(targetId);
    else set.add(targetId);
    me.closeFriends = Array.from(set).slice(0, 500);
    await saveDatabase(db2, false);
    if (isTursoConfigured()) await tursoUpsertUser(me);
    return c.json({ ids: me.closeFriends, added: me.closeFriends.includes(targetId) });
  } catch (e) {
    console.error("[close-friends]", e);
    return c.json({ error: "Update failed" }, 500);
  }
});
app.get("/api/users", requireAuth, async (c) => {
  const db2 = await fetchDatabase();
  const sdb = isTursoConfigured() ? await fetchTursoMirror(db2) : db2;
  const sourceUsers = (sdb.users || []).length ? sdb.users : db2.users || [];
  const myId = c.get("userId");
  const me = sourceUsers.find((u) => u.id === myId);
  const myBlocked = new Set(me && me.blocked || []);
  const blockedMe = /* @__PURE__ */ new Set();
  sourceUsers.forEach((u) => {
    if (u.id !== myId && Array.isArray(u.blocked) && u.blocked.includes(myId)) blockedMe.add(u.id);
  });
  const now = nowMs();
  const myFollowing = new Set(me && me.following || []);
  let lastByPeer = {};
  if (isTursoConfigured()) {
    lastByPeer = await fetchTursoDmIndex(myId);
  } else {
    for (const m of db2.messages || []) {
      if (typeof m.roomId !== "string" || !m.roomId.startsWith("dm:")) continue;
      const parts = m.roomId.slice(3).split(":");
      if (!parts.includes(myId)) continue;
      const peer = parts.find((id) => id !== myId);
      if (!peer) continue;
      if (!lastByPeer[peer] || (m.createdAt || 0) > (lastByPeer[peer].createdAt || 0)) {
        let preview;
        if (m.encrypted) preview = "\u{1F512} Encrypted message";
        else if (m.storyReply) preview = "Replied to a story";
        else if (m.imageUrl) preview = "\u{1F4F7} Photo";
        else preview = String(m.text || "").slice(0, 60);
        lastByPeer[peer] = { text: preview, createdAt: m.createdAt || 0, fromMe: m.userId === myId };
      }
    }
  }
  const list = sourceUsers.filter((u) => !myBlocked.has(u.id) && !blockedMe.has(u.id)).map((u) => ({
    ...sanitizeUser(u),
    online: now - (db2.heartbeat && db2.heartbeat[u.id] || 0) < 45e3,
    lastSeen: db2.heartbeat && db2.heartbeat[u.id] || 0,
    iFollow: myFollowing.has(u.id),
    followsMe: Array.isArray(u.following) && u.following.includes(myId),
    lastMessage: lastByPeer[u.id] || null
  }));
  return c.json({ users: list });
});
app.post("/api/user/public-key", requireAuth, async (c) => {
  try {
    const { publicKey } = await c.req.json().catch(() => ({}));
    if (typeof publicKey !== "string" || publicKey.length < 32 || publicKey.length > 256) {
      return c.json({ error: "Invalid key" }, 400);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(publicKey)) return c.json({ error: "Invalid key format" }, 400);
    const db2 = await fetchDatabase();
    const u = db2.users.find((x) => x.id === c.get("userId"));
    if (!u) return c.json({ error: "Not found" }, 404);
    u.publicKey = publicKey;
    u.publicKeyUpdatedAt = nowMs();
    await saveDatabase(db2, false);
    return c.json({ ok: true });
  } catch (e) {
    console.error("[public-key]", e);
    return c.json({ error: "Save failed" }, 500);
  }
});
app.get("/api/user/public-key", requireAuth, async (c) => {
  const userId = c.req.query("userId");
  if (!userId) return c.json({ error: "userId required" }, 400);
  let db2 = await fetchDatabase();
  let u = db2.users.find((x) => x.id === userId);
  if (!u || !u.publicKey) {
    cacheTimestamp = 0;
    db2 = await fetchDatabase();
    u = db2.users.find((x) => x.id === userId);
  }
  if (!u) return c.json({ error: "Not found" }, 404);
  return c.json({ userId: u.id, publicKey: u.publicKey || null });
});
app.post("/api/user/heartbeat", requireAuth, async (c) => {
  const db2 = await fetchDatabase();
  db2.heartbeat[c.get("userId")] = nowMs();
  await saveDatabase(db2, true);
  return c.json({ ok: true });
});
app.post("/api/user/note", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const db2 = await fetchDatabase();
  const u = db2.users.find((x) => x.id === c.get("userId"));
  if (!u) return c.json({ error: "Not found" }, 404);
  const text = sanitizeText(body.text || "", 60).trim();
  const music = cleanNoteMusic(body.music);
  if (!text && !music) {
    u.note = null;
  } else {
    u.note = { text, music, createdAt: nowMs(), expiresAt: nowMs() + 24 * 3600 * 1e3 };
  }
  await saveDatabase(db2, false);
  return c.json({ ok: true, note: activeNote(u) });
});
function cleanNoteMusic(m) {
  if (!m || typeof m !== "object" || !m.title) return null;
  return {
    title: sanitizeText(m.title, 80),
    artist: sanitizeText(m.artist || "", 80),
    audio: isSafeMediaUrl(m.audio, { allowData: false }) ? String(m.audio).trim().slice(0, 1024) : "",
    art: isSafeImageUrl(m.art, { allowData: false }) ? String(m.art).trim().slice(0, 1024) : ""
  };
}
__name(cleanNoteMusic, "cleanNoteMusic");
app.post("/api/user/typing", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.roomId) return c.json({ error: "roomId required" }, 400);
  const roomId = normalizeRoomId(body.roomId, c.get("userId"));
  const db2 = await fetchDatabase();
  if (!db2.typing[roomId]) db2.typing[roomId] = {};
  db2.typing[roomId][c.get("userId")] = nowMs();
  await saveDatabase(db2, true);
  return c.json({ ok: true });
});
app.get("/api/user/typing", requireAuth, async (c) => {
  const roomId = normalizeRoomId(c.req.query("roomId"), c.get("userId"));
  if (!roomId) return c.json({ error: "roomId required" }, 400);
  const db2 = await fetchDatabase();
  const map = db2.typing[roomId] || {};
  const now = nowMs();
  const myId = c.get("userId");
  const typing = Object.keys(map).filter((uid2) => uid2 !== myId && now - map[uid2] < 4e3).map((id) => {
    const u = db2.users.find((x) => x.id === id);
    return u ? { id: u.id, username: u.username, displayName: u.displayName } : null;
  }).filter(Boolean);
  return c.json({ typing });
});
app.get("/api/messages", requireAuth, async (c) => {
  cacheTimestamp = 0;
  const roomId = normalizeRoomId(c.req.query("roomId") || "general-group", c.get("userId"));
  if (roomId.startsWith("dm:")) {
    const parts = roomId.slice(3).split(":");
    if (!parts.includes(c.get("userId"))) return c.json({ error: "Forbidden" }, 403);
  }
  let db2 = await fetchDatabase({ fresh: true });
  let now = nowMs();
  const dbRoomMessages = /* @__PURE__ */ __name(() => db2.messages.filter((m) => m.roomId === roomId && !m.deletedAt && !(m.disappearAt && m.disappearAt <= now)).sort((a, b) => a.createdAt - b.createdAt).slice(-200), "dbRoomMessages");
  let list = await fetchTursoMessages(roomId, now);
  if (!Array.isArray(list) || list.length === 0 && db2.messages.some((m) => m.roomId === roomId && !m.deletedAt)) {
    list = dbRoomMessages();
  }
  if (list.length === 0 && roomId.startsWith("dm:")) {
    await sleepMs(900);
    cacheTimestamp = 0;
    db2 = await fetchDatabase({ fresh: true });
    now = nowMs();
    const mirrorRetry = await fetchTursoMessages(roomId, now);
    const primaryRetry = db2.messages.filter((m) => m.roomId === roomId && !m.deletedAt && !(m.disappearAt && m.disappearAt <= now)).sort((a, b) => a.createdAt - b.createdAt).slice(-200);
    list = Array.isArray(mirrorRetry) && (mirrorRetry.length > 0 || primaryRetry.length === 0) ? mirrorRetry : primaryRetry;
  }
  const enriched = list.map((m) => {
    const author = db2.users.find((u) => u.id === m.userId);
    if (author) return { ...m, author: sanitizeUser(author) };
    if (m.authorSnapshot) return { ...m, author: m.authorSnapshot };
    return { ...m, author: { id: m.userId, displayName: "Member", username: (m.userId || "member").slice(-6) } };
  });
  return c.json({ messages: enriched, roomId });
});
app.post("/api/messages/send", requireAuth, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const {
      roomId: raw2,
      text,
      imageUrl,
      replyTo,
      targetUserId,
      encrypted,
      cipher,
      iv,
      // E2E payload (Part 3)
      disappearAfterMs
      // disappearing messages (Part 3)
    } = body;
    const myId = c.get("userId");
    let roomId = raw2;
    if (!roomId && targetUserId) roomId = dmRoomFor(myId, targetUserId);
    roomId = normalizeRoomId(roomId || "general-group", myId);
    if (roomId.startsWith("dm:")) {
      const parts = roomId.slice(3).split(":");
      if (!parts.includes(myId)) return c.json({ error: "Forbidden" }, 403);
    }
    const isEncrypted = !!encrypted && typeof cipher === "string" && typeof iv === "string";
    if (isEncrypted && !roomId.startsWith("dm:")) {
      return c.json({ error: "E2E only supported in DMs" }, 400);
    }
    if (isEncrypted) {
      if (cipher.length > 12e3 || iv.length > 64) {
        return c.json({ error: "Payload too large" }, 413);
      }
    }
    const ct = isEncrypted ? "" : sanitizeText(text, 4e3);
    const ci = isSafeMediaUrl(imageUrl) ? String(imageUrl).trim() : null;
    if (!ct && !ci && !isEncrypted) return c.json({ error: "Empty message" }, 400);
    let disappearAt = null;
    if (typeof disappearAfterMs === "number" && disappearAfterMs > 0) {
      const ms = Math.max(1e4, Math.min(24 * 60 * 60 * 1e3, disappearAfterMs));
      disappearAt = nowMs() + ms;
    }
    const db2 = await fetchDatabase();
    let replyRef = null;
    if (replyTo && typeof replyTo === "object" && replyTo.id) {
      replyRef = {
        id: replyTo.id,
        text: typeof replyTo.text === "string" ? replyTo.text.slice(0, 200) : "",
        username: typeof replyTo.username === "string" ? replyTo.username.slice(0, 60) : "",
        imageUrl: isSafeMediaUrl(replyTo.imageUrl) ? String(replyTo.imageUrl).trim().slice(0, 2048) : null
      };
    }
    const author = db2.users.find((u) => u.id === myId);
    const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || "" } : null;
    const msg = {
      id: uid("msg"),
      roomId,
      userId: myId,
      text: ct,
      imageUrl: ci,
      replyTo: replyRef,
      authorSnapshot: snap,
      createdAt: nowMs()
    };
    if (isEncrypted) {
      msg.encrypted = true;
      msg.cipher = cipher;
      msg.iv = iv;
    }
    if (disappearAt) {
      msg.disappearAt = disappearAt;
      msg.disappearAfterMs = disappearAfterMs;
    }
    db2.messages.push(msg);
    const enriched = { ...msg, author: snap || { id: myId, displayName: "Member", username: "member" } };
    const tursoNotifs = [];
    if (roomId.startsWith("dm:")) {
      const parts = roomId.slice(3).split(":");
      parts.filter((uid2) => uid2 !== myId).forEach((recip) => {
        _pushEvent(recip, "new_message", { roomId, message: enriched });
        const previewText = isEncrypted ? "\u{1F512} Encrypted message" : ct || (ci ? "\u{1F4F7} Photo" : "");
        const notif = pushNotification(db2, recip, "message", myId, { text: previewText.slice(0, 80) });
        if (notif) tursoNotifs.push(notif);
      });
    } else {
      _broadcastEvent("new_message", { roomId, message: enriched }, myId);
    }
    const persisted = await saveDatabaseVerified(db2, (d) => (d.messages || []).some((m) => m.id === msg.id), 4, { skipSecondarySync: true });
    if (isPersist() && !persisted) return c.json({ error: "Message storage unavailable. Please retry." }, 503);
    if (isTursoConfigured()) {
      const stmts = [];
      stmts.push({
        sql: "INSERT INTO ps_messages (id, room_id, user_id, created_at, deleted_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET deleted_at=excluded.deleted_at, updated_at=excluded.updated_at, data_json=excluded.data_json",
        args: [msg.id, msg.roomId, msg.userId, Number(msg.createdAt || 0), msg.deletedAt ? Number(msg.deletedAt) : null, nowMs(), JSON.stringify(msg)]
      });
      for (const n of tursoNotifs) {
        stmts.push({
          sql: "INSERT INTO ps_notifications (id, user_id, kind, from_user_id, post_id, comment_id, created_at, seen_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at, data_json=excluded.data_json",
          args: [n.id, n.userId, n.kind, n.fromUserId, n.postId || null, n.commentId || null, Number(n.createdAt || 0), n.seenAt ? Number(n.seenAt) : null, JSON.stringify(n)]
        });
      }
      if (roomId.startsWith("dm:")) {
        const ownerIds = roomId.slice(3).split(":").filter(Boolean);
        for (const oid of ownerIds) {
          stmts.push({
            sql: "INSERT INTO ps_dm_index (owner_user_id, peer_user_id, last_message_id, last_message_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner_user_id, peer_user_id) DO UPDATE SET last_message_id=excluded.last_message_id, last_message_at=excluded.last_message_at, updated_at=excluded.updated_at",
            args: [oid, myId, msg.id, Number(msg.createdAt || 0), nowMs()]
          });
        }
      }
      try {
        await tursoClient().batch(stmts, "write");
      } catch (e) {
        console.warn("[send] batched write failed, falling back to non-batched:", e && e.message);
        try {
          await tursoUpsertMessages([msg]);
          if (tursoNotifs.length) await tursoUpsertNotifications(tursoNotifs);
          if (roomId.startsWith("dm:")) await tursoRefreshDmIndexForOwners(db2, roomId.slice(3).split(":").filter(Boolean));
        } catch (_) {
        }
      }
    }
    return c.json({ message: enriched });
  } catch (e) {
    console.error("[send]", e);
    return c.json({ error: "Send failed" }, 500);
  }
});
app.post("/api/messages/delete", requireAuth, async (c) => {
  try {
    const { messageId } = await c.req.json().catch(() => ({}));
    if (!messageId) return c.json({ error: "messageId required" }, 400);
    const db2 = await fetchDatabase();
    const m = db2.messages.find((x) => x.id === messageId);
    if (!m) return c.json({ error: "Not found" }, 404);
    if (m.userId !== c.get("userId")) return c.json({ error: "Forbidden" }, 403);
    m.deletedAt = nowMs();
    await saveDatabase(db2, false, { skipSecondarySync: true });
    if (isTursoConfigured()) {
      await tursoUpsertMessages([m]);
      if (typeof m.roomId === "string" && m.roomId.startsWith("dm:")) await tursoRefreshDmIndexForOwners(db2, m.roomId.slice(3).split(":").filter(Boolean));
    }
    return c.json({ ok: true, undoUntil: m.deletedAt + 30 * 24 * 3600 * 1e3 });
  } catch (e) {
    console.error("[delmsg]", e);
    return c.json({ error: "Delete failed" }, 500);
  }
});
app.post("/api/messages/restore", requireAuth, async (c) => {
  try {
    const { messageId } = await c.req.json().catch(() => ({}));
    const db2 = await fetchDatabase();
    const m = db2.messages.find((x) => x.id === messageId);
    if (!m) return c.json({ error: "Not found" }, 404);
    if (m.userId !== c.get("userId")) return c.json({ error: "Forbidden" }, 403);
    delete m.deletedAt;
    await saveDatabase(db2, false, { skipSecondarySync: true });
    if (isTursoConfigured()) {
      await tursoUpsertMessages([m]);
      if (typeof m.roomId === "string" && m.roomId.startsWith("dm:")) await tursoRefreshDmIndexForOwners(db2, m.roomId.slice(3).split(":").filter(Boolean));
    }
    return c.json({ ok: true });
  } catch (e) {
    console.error("[restoremsg]", e);
    return c.json({ error: "Restore failed" }, 500);
  }
});
app.post("/api/messages/schedule", requireAuth, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { roomId: raw2, targetUserId, text, imageUrl, deliverAt, replyTo } = body;
    const myId = c.get("userId");
    let roomId = raw2;
    if (!roomId && targetUserId) roomId = dmRoomFor(myId, targetUserId);
    roomId = normalizeRoomId(roomId || "general-group", myId);
    const ts = Number(deliverAt);
    if (!ts || isNaN(ts) || ts < nowMs() + 5e3) return c.json({ error: "deliverAt must be at least 5s in future" }, 400);
    const ct = sanitizeText(text, 4e3);
    const ci = isSafeMediaUrl(imageUrl) ? String(imageUrl).trim() : null;
    if (!ct && !ci) return c.json({ error: "Empty message" }, 400);
    if (roomId.startsWith("dm:")) {
      const parts = roomId.slice(3).split(":");
      if (!parts.includes(myId)) return c.json({ error: "Forbidden" }, 403);
    }
    const db2 = await fetchDatabase();
    let replyRef = null;
    if (replyTo && typeof replyTo === "object" && replyTo.id) {
      replyRef = {
        id: replyTo.id,
        text: typeof replyTo.text === "string" ? replyTo.text.slice(0, 200) : "",
        username: typeof replyTo.username === "string" ? replyTo.username.slice(0, 60) : "",
        imageUrl: isSafeMediaUrl(replyTo.imageUrl) ? String(replyTo.imageUrl).trim().slice(0, 2048) : null
      };
    }
    const author = db2.users.find((u) => u.id === myId);
    const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || "" } : null;
    const sm = { id: uid("sched"), roomId, userId: myId, text: ct, imageUrl: ci, replyTo: replyRef, authorSnapshot: snap, deliverAt: ts, createdAt: nowMs() };
    db2.scheduledMessages.push(sm);
    await saveDatabase(db2, false);
    return c.json({ scheduled: sm });
  } catch (e) {
    return c.json({ error: "Schedule failed" }, 500);
  }
});
app.get("/api/messages/scheduled", requireAuth, async (c) => {
  const db2 = await fetchDatabase();
  const list = db2.scheduledMessages.filter((s) => s.userId === c.get("userId")).sort((a, b) => a.deliverAt - b.deliverAt);
  return c.json({ scheduled: list });
});
app.post("/api/messages/scheduled/cancel", requireAuth, async (c) => {
  const { id } = await c.req.json().catch(() => ({}));
  if (!id) return c.json({ error: "id required" }, 400);
  const db2 = await fetchDatabase();
  const idx = db2.scheduledMessages.findIndex((s) => s.id === id);
  if (idx === -1) return c.json({ error: "Not found" }, 404);
  if (db2.scheduledMessages[idx].userId !== c.get("userId")) return c.json({ error: "Forbidden" }, 403);
  db2.scheduledMessages.splice(idx, 1);
  await saveDatabase(db2, false);
  return c.json({ ok: true });
});
app.get("/api/notifications", requireAuth, async (c) => {
  cacheTimestamp = 0;
  const db2 = await fetchDatabase();
  const myId = c.get("userId");
  const sourceUsers = db2.users || [];
  const mine = isTursoConfigured() ? await fetchTursoNotifications(myId) : (db2.notifications || []).filter((n) => n.userId === myId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  const enriched = mine.map((n) => {
    const author = sourceUsers.find((u) => u.id === n.fromUserId);
    return { ...n, from: author ? sanitizeUser(author) : n.fromSnapshot || { id: n.fromUserId, displayName: "Member", username: "member" } };
  });
  return c.json({ notifications: enriched, unread: enriched.filter((n) => !n.seenAt).length });
});
app.post("/api/notifications/seen", requireAuth, async (c) => {
  const db2 = await fetchDatabase();
  const now = nowMs();
  let n = 0;
  const touched = [];
  (db2.notifications || []).forEach((x) => {
    if (x.userId === c.get("userId") && !x.seenAt) {
      x.seenAt = now;
      n++;
      touched.push(x);
    }
  });
  if (n) {
    await saveDatabase(db2, true);
    if (isTursoConfigured()) await tursoUpsertNotifications(touched);
  }
  return c.json({ ok: true, updated: n });
});
app.post("/api/notifications/clear", requireAuth, async (c) => {
  const db2 = await fetchDatabase();
  const before = (db2.notifications || []).length;
  db2.notifications = (db2.notifications || []).filter((n) => n.userId !== c.get("userId"));
  if (before !== db2.notifications.length) {
    await saveDatabase(db2, false, { skipSecondarySync: true });
    if (isTursoConfigured()) await tursoClearNotificationsForUser(c.get("userId"));
  }
  return c.json({ ok: true, removed: before - db2.notifications.length });
});
app.post("/api/user/follow", requireAuth, async (c) => {
  const { targetId } = await c.req.json().catch(() => ({}));
  const myId = c.get("userId");
  if (!targetId || targetId === myId) return c.json({ error: "Invalid target" }, 400);
  const db2 = await fetchDatabase();
  const me = db2.users.find((u) => u.id === myId);
  const target = db2.users.find((u) => u.id === targetId);
  if (!me || !target) return c.json({ error: "User not found" }, 404);
  if (Array.isArray(target.blocked) && target.blocked.includes(myId)) return c.json({ error: "Cannot follow this user" }, 403);
  if (Array.isArray(me.blocked) && me.blocked.includes(targetId)) return c.json({ error: "Unblock this user first" }, 403);
  me.following = me.following || [];
  target.followers = target.followers || [];
  if (!me.following.includes(targetId)) me.following.push(targetId);
  if (!target.followers.includes(myId)) target.followers.push(myId);
  pushNotification(db2, targetId, "follow", myId);
  await saveDatabase(db2, false);
  if (isTursoConfigured()) {
    await tursoUpsertUser(me);
    await tursoUpsertUser(target);
    try {
      const tc = tursoClient();
      const recentPosts = await tc.execute({
        sql: `SELECT id, created_at FROM ps_posts WHERE user_id = ? AND (story IS NULL OR story = 0) ORDER BY created_at DESC LIMIT 50`,
        args: [targetId]
      }).catch(() => ({ rows: [] }));
      if (recentPosts.rows?.length) {
        const feedRows = recentPosts.rows.map((r) => ({
          userId: myId,
          postId: r.id,
          createdAt: Number(r.created_at) || nowMs()
        }));
        await tursoUpsertUserFeeds(feedRows);
      }
    } catch (_) {
    }
  }
  return c.json({ ok: true, following: me.following.length, followers: target.followers.length, followingIds: me.following, targetFollowerIds: target.followers });
});
app.post("/api/user/unfollow", requireAuth, async (c) => {
  const { targetId } = await c.req.json().catch(() => ({}));
  if (!targetId) return c.json({ error: "targetId required" }, 400);
  const db2 = await fetchDatabase();
  const me = db2.users.find((u) => u.id === c.get("userId"));
  const target = db2.users.find((u) => u.id === targetId);
  if (!me || !target) return c.json({ error: "User not found" }, 404);
  me.following = (me.following || []).filter((id) => id !== targetId);
  target.followers = (target.followers || []).filter((id) => id !== c.get("userId"));
  await saveDatabase(db2, false);
  if (isTursoConfigured()) {
    await tursoUpsertUser(me);
    await tursoUpsertUser(target);
  }
  return c.json({ ok: true, following: me.following.length, followers: target.followers.length, followingIds: me.following, targetFollowerIds: target.followers });
});
app.post("/api/user/block", requireAuth, async (c) => {
  const { targetId } = await c.req.json().catch(() => ({}));
  const myId = c.get("userId");
  if (!targetId || targetId === myId) return c.json({ error: "Invalid target" }, 400);
  const db2 = await fetchDatabase();
  const me = db2.users.find((u) => u.id === myId);
  const target = db2.users.find((u) => u.id === targetId);
  if (!me || !target) return c.json({ error: "User not found" }, 404);
  me.blocked = me.blocked || [];
  if (!me.blocked.includes(targetId)) me.blocked.push(targetId);
  me.following = (me.following || []).filter((id) => id !== targetId);
  target.followers = (target.followers || []).filter((id) => id !== myId);
  target.following = (target.following || []).filter((id) => id !== myId);
  me.followers = (me.followers || []).filter((id) => id !== targetId);
  db2.notifications = (db2.notifications || []).filter((n) => !(n.userId === myId && n.fromUserId === targetId || n.userId === targetId && n.fromUserId === myId));
  await saveDatabase(db2, false);
  if (isTursoConfigured()) {
    await tursoUpsertUser(me);
    await tursoUpsertUser(target);
  }
  return c.json({ ok: true });
});
app.post("/api/user/unblock", requireAuth, async (c) => {
  const { targetId } = await c.req.json().catch(() => ({}));
  if (!targetId) return c.json({ error: "targetId required" }, 400);
  const db2 = await fetchDatabase();
  const me = db2.users.find((u) => u.id === c.get("userId"));
  if (!me) return c.json({ error: "Not found" }, 404);
  me.blocked = (me.blocked || []).filter((id) => id !== targetId);
  await saveDatabase(db2, false);
  if (isTursoConfigured()) await tursoUpsertUser(me);
  return c.json({ ok: true });
});
app.get("/api/user/:id/profile", requireAuth, async (c) => {
  const targetId = c.req.param("id");
  const myId = c.get("userId");
  cacheTimestamp = 0;
  const sdb = isTursoConfigured() ? await fetchTursoMirror() : await fetchDatabase({ fresh: true });
  const sourceUsers = sdb.users || [];
  const sourcePosts = sdb.posts || [];
  const target = sourceUsers.find((u) => u.id === targetId);
  if (!target) return c.json({ error: "Not found" }, 404);
  const me = sourceUsers.find((u) => u.id === myId);
  const blockedMe = Array.isArray(target.blocked) && target.blocked.includes(myId);
  const iBlocked = me && Array.isArray(me.blocked) && me.blocked.includes(targetId);
  if (blockedMe) return c.json({ error: "Profile unavailable" }, 403);
  const posts = sourcePosts.filter((p) => p.userId === targetId && !p.deletedAt && !isStoryRecord(p)).sort((a, b) => b.createdAt - a.createdAt).map((p) => ({ id: p.id, userId: p.userId, imageUrl: p.imageUrl || (Array.isArray(p.images) ? p.images[0] : null), images: Array.isArray(p.images) ? p.images : [], videoUrl: p.videoUrl || null, text: p.text, createdAt: p.createdAt, likeCount: (p.likes || []).length, commentCount: (p.comments || []).length, authorSnapshot: p.authorSnapshot || null }));
  const followerIds = Array.from(/* @__PURE__ */ new Set([
    ...Array.isArray(target.followers) ? target.followers : [],
    ...sourceUsers.filter((u) => Array.isArray(u.following) && u.following.includes(targetId)).map((u) => u.id)
  ])).filter((id) => id && id !== targetId);
  const followingIds = Array.from(new Set(Array.isArray(target.following) ? target.following : [])).filter((id) => id && id !== targetId);
  const canViewCard = canViewProfileCard(target, myId);
  const cardVisibility = ["everyone", "close_friends", "private"].includes(target.cardVisibility) ? target.cardVisibility : "everyone";
  const profileUser = { ...sanitizeUser(target, targetId === myId), followers: followerIds.length, following: followingIds.length, followerIds, followingIds, postsCount: posts.length };
  profileUser.card = canViewCard ? {
    canView: true,
    visibility: cardVisibility,
    dateOfBirth: target.dateOfBirth || "",
    postsCount: posts.length,
    followers: followerIds.length,
    following: followingIds.length
  } : { canView: false, visibility: cardVisibility };
  return c.json({
    user: profileUser,
    posts,
    relationship: {
      isMe: targetId === myId,
      iFollow: !!(me && (me.following || []).includes(targetId)),
      followsMe: Array.isArray(target.following) && target.following.includes(myId),
      iBlocked
    }
  });
});
app.get("/api/posts", requireAuth, async (c) => {
  cacheTimestamp = 0;
  const sdb = isTursoConfigured() ? await fetchTursoMirror() : await fetchDatabase();
  const sourceUsers = sdb.users || [];
  const sourcePosts = sdb.posts || [];
  const myId = c.get("userId");
  const me = sourceUsers.find((u) => u.id === myId);
  const myBlocked = new Set(me && me.blocked || []);
  const blockedMe = /* @__PURE__ */ new Set();
  sourceUsers.forEach((u) => {
    if (u.id !== myId && Array.isArray(u.blocked) && u.blocked.includes(myId)) blockedMe.add(u.id);
  });
  const structuredDb = normalizeDb({ users: sourceUsers, posts: sourcePosts });
  const list = sourcePosts.filter((p) => !p.deletedAt && !myBlocked.has(p.userId) && !blockedMe.has(p.userId) && canViewerSeeStory(p, myId, structuredDb)).slice().sort((a, b) => b.createdAt - a.createdAt).map((p) => {
    const author = sourceUsers.find((u) => u.id === p.userId);
    const comments = (p.comments || []).map((cm) => {
      const cu = sourceUsers.find((u) => u.id === cm.userId);
      const ca = cu ? sanitizeUser(cu) : cm.authorSnapshot || { id: cm.userId, displayName: "Member", username: (cm.userId || "m").slice(-6) };
      return { ...cm, author: ca };
    });
    const pa = author ? sanitizeUser(author) : p.authorSnapshot || { id: p.userId, displayName: "Member", username: (p.userId || "m").slice(-6) };
    const images = Array.isArray(p.images) && p.images.length > 0 ? p.images : p.imageUrl ? [p.imageUrl] : [];
    const isOwner = p.userId === myId;
    const viewCount = Array.isArray(p.views) ? p.views.length : 0;
    const base = { ...p, imageUrl: images[0] || null, images, music: p.music || null, isScratch: !!p.isScratch, likes: p.likes || [], likeCount: (p.likes || []).length, comments, commentCount: comments.length, author: pa };
    if (!isOwner) delete base.views;
    if (isStoryRecord(p)) base.viewCount = isOwner ? viewCount : void 0;
    return base;
  });
  return c.json({ posts: list });
});
app.post("/api/posts/create", requireAuth, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { text, imageUrl, images, videoUrl, isScratch, music, style, story, storyExpiresAt: storyExpiresAt2, audience } = body;
    const ct = sanitizeText(text, 2e3);
    const ci = isSafeImageUrl(imageUrl) ? String(imageUrl).trim() : null;
    const cimgs = Array.isArray(images) ? images.filter((u) => isSafeImageUrl(u)).map((u) => String(u).trim()).slice(0, 3) : ci ? [ci] : [];
    const mainImg = cimgs[0] || ci || null;
    const cvid = isSafeMediaUrl(videoUrl) && (/^https?:\/\//i.test(String(videoUrl)) || /^data:video\//i.test(String(videoUrl))) ? String(videoUrl).trim() : null;
    if (!ct && !mainImg && cimgs.length === 0 && !cvid) return c.json({ error: "Empty post" }, 400);
    const myId = c.get("userId");
    const db2 = await fetchDatabase();
    const author = db2.users.find((u) => u.id === myId);
    const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || "" } : null;
    const cleanMusic = music && typeof music === "object" && music.title ? {
      id: music.id,
      title: sanitizeText(music.title, 60),
      artist: sanitizeText(music.artist || "", 60),
      audio: isSafeMediaUrl(music.audio, { allowData: false }) ? String(music.audio).trim().slice(0, 1024) : "",
      art: isSafeImageUrl(music.art, { allowData: false }) ? String(music.art).trim().slice(0, 1024) : "",
      posX: Math.max(0, Math.min(100, Number(music.posX) || 50)),
      posY: Math.max(0, Math.min(100, Number(music.posY) || 32)),
      startTime: Math.max(0, Math.min(180, Number(music.startTime) || 0)),
      clipDur: Math.max(10, Math.min(30, Number(music.clipDur) || 30)),
      scale: Math.max(0.5, Math.min(2.5, Number(music.scale) || 1)),
      layout: ["pill", "card", "minimal"].includes(music.layout) ? music.layout : "pill"
    } : null;
    const cleanStyle = style && typeof style === "object" ? {
      font: String(style.font || "modern").slice(0, 32),
      color: String(style.color || "#ffffff").slice(0, 32),
      bg: !!style.bg,
      bgMode: ["none", "solid", "soft", "outline"].includes(style.bgMode) ? style.bgMode : style.bg ? "solid" : "none",
      align: ["left", "center", "right"].includes(style.align) ? style.align : "center",
      size: Math.max(16, Math.min(52, Number(style.size) || 28)),
      posX: Math.max(0, Math.min(100, Number(style.posX) || 50)),
      posY: Math.max(0, Math.min(100, Number(style.posY) || 68)),
      scale: Math.max(0.5, Math.min(2.5, Number(style.scale) || 1))
    } : null;
    const isStory = story === true;
    const expiresAt = isStory ? Math.max(nowMs() + 6e4, Math.min(nowMs() + 7 * 24 * 3600 * 1e3, Number(storyExpiresAt2) || nowMs() + 24 * 3600 * 1e3)) : null;
    const post = {
      id: uid("post"),
      userId: myId,
      text: ct,
      imageUrl: mainImg,
      images: cimgs.length > 0 ? cimgs : mainImg ? [mainImg] : [],
      videoUrl: cvid,
      music: cleanMusic,
      style: cleanStyle,
      story: isStory,
      storyExpiresAt: expiresAt,
      audience: isStory ? audience === "close_friends" ? "close_friends" : "all" : null,
      isScratch: !!isScratch,
      likes: [],
      comments: [],
      authorSnapshot: snap,
      createdAt: nowMs()
    };
    db2.posts.push(post);
    const enriched = { ...post, likeCount: 0, commentCount: 0, author: snap || { id: myId, displayName: "Member", username: "member" } };
    _broadcastEvent("new_post", { post: enriched }, myId);
    const persisted = await saveDatabaseVerified(db2, (d) => (d.posts || []).some((p) => p.id === post.id), 4, { skipSecondarySync: true });
    if (isPersist() && !persisted) return c.json({ error: "Post storage unavailable. Please retry." }, 503);
    if (isTursoConfigured()) {
      await tursoUpsertPosts([post]);
      await fanoutPostToFollowers(post, db2);
    }
    return c.json({ post: enriched });
  } catch (e) {
    return c.json({ error: "Create post failed" }, 500);
  }
});
app.post("/api/posts/like", requireAuth, async (c) => {
  const { postId } = await c.req.json().catch(() => ({}));
  if (!postId) return c.json({ error: "postId required" }, 400);
  let db2 = await fetchDatabase();
  let post = db2.posts.find((p) => p.id === postId);
  if (!post) {
    cacheTimestamp = 0;
    db2 = await fetchDatabase();
    post = db2.posts.find((p) => p.id === postId);
  }
  if (!post) return c.json({ error: "Not found" }, 404);
  post.likes = post.likes || [];
  const myId = c.get("userId");
  const idx = post.likes.indexOf(myId);
  let liked;
  if (idx === -1) {
    post.likes.push(myId);
    liked = true;
  } else {
    post.likes.splice(idx, 1);
    liked = false;
  }
  const notif = liked ? pushNotification(db2, post.userId, "like", myId, { postId: post.id }) : null;
  await saveDatabase(db2, false, { skipSecondarySync: true });
  if (isTursoConfigured()) {
    await tursoUpsertPosts([post]);
    if (notif) await tursoUpsertNotifications([notif]);
  }
  return c.json({ liked, likeCount: post.likes.length });
});
app.post("/api/rtc/signal", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { targetId, signal } = body;
  if (typeof targetId !== "string" || !/^[a-zA-Z0-9_-]{1,96}$/.test(targetId) || !signal || typeof signal !== "object") return c.json({ error: "Missing data" }, 400);
  const signalType = sanitizeText(signal.type || "", 24);
  if (!["offer", "answer", "candidate", "end", "reject", "busy"].includes(signalType)) return c.json({ error: "Invalid signal" }, 400);
  if (JSON.stringify(signal).length > 2e4) return c.json({ error: "Signal too large" }, 413);
  const myId = c.get("userId");
  if (targetId === myId) return c.json({ error: "Invalid target" }, 400);
  const db2 = await fetchDatabase();
  if (!db2.users.some((u) => u.id === targetId)) return c.json({ error: "Target not found" }, 404);
  const me = db2.users.find((u) => u.id === myId);
  const author = me ? { id: me.id, username: me.username, displayName: me.displayName, photoUrl: me.photoUrl || "" } : { id: myId, displayName: "Member", username: "member" };
  const payload = { fromId: myId, author, signal };
  db2.rtcSignals = Array.isArray(db2.rtcSignals) ? db2.rtcSignals : [];
  if (signalType === "end" || signalType === "reject" || signalType === "busy") {
    db2.rtcSignals = db2.rtcSignals.filter((x) => !(x.targetId === targetId && x.payload?.fromId === myId || x.targetId === myId && x.payload?.fromId === targetId));
  }
  const expiresAt = nowMs() + (signalType === "offer" ? 2e4 : 6e4);
  db2.rtcSignals.push({ id: uid("rtc"), targetId, payload, createdAt: nowMs(), expiresAt });
  if (db2.rtcSignals.length > 200) db2.rtcSignals = db2.rtcSignals.slice(-200);
  _pushEvent(targetId, "rtc_signal", payload);
  const persisted = await saveDatabaseVerified(db2, (d) => (d.rtcSignals || []).some((x) => x.id === db2.rtcSignals[db2.rtcSignals.length - 1].id));
  if (isPersist() && !persisted) return c.json({ error: "Call signal storage unavailable. Please retry." }, 503);
  return c.json({ ok: true });
});
app.get("/api/rtc/signals", requireAuth, async (c) => {
  cacheTimestamp = 0;
  const since = Number(c.req.query("since") || 0) || 0;
  const myId = c.get("userId");
  const db2 = await fetchDatabase({ fresh: true });
  const now = nowMs();
  db2.rtcSignals = Array.isArray(db2.rtcSignals) ? db2.rtcSignals.filter((x) => !x.expiresAt || x.expiresAt > now) : [];
  let signals = db2.rtcSignals.filter((x) => x.targetId === myId && (x.createdAt || 0) > since && now - (x.createdAt || 0) <= 45e3).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).slice(-30).map((x) => ({ id: x.id, createdAt: x.createdAt, ...x.payload }));
  if (signals.length === 0) {
    await sleepMs(500);
    cacheTimestamp = 0;
    const db22 = await fetchDatabase({ fresh: true });
    const now2 = nowMs();
    db22.rtcSignals = Array.isArray(db22.rtcSignals) ? db22.rtcSignals.filter((x) => !x.expiresAt || x.expiresAt > now2) : [];
    signals = db22.rtcSignals.filter((x) => x.targetId === myId && (x.createdAt || 0) > since && now2 - (x.createdAt || 0) <= 45e3).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).slice(-30).map((x) => ({ id: x.id, createdAt: x.createdAt, ...x.payload }));
  }
  return c.json({ signals, now });
});
app.post("/api/posts/comment", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { postId, text } = body;
  if (!postId) return c.json({ error: "postId required" }, 400);
  const ct = sanitizeText(text, 600).trim();
  if (!ct) return c.json({ error: "Empty comment" }, 400);
  let db2 = await fetchDatabase();
  let post = db2.posts.find((p) => p.id === postId);
  if (!post) {
    cacheTimestamp = 0;
    db2 = await fetchDatabase();
    post = db2.posts.find((p) => p.id === postId);
  }
  if (!post) return c.json({ error: "Not found" }, 404);
  post.comments = post.comments || [];
  const myId = c.get("userId");
  const author = db2.users.find((u) => u.id === myId);
  const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || "" } : null;
  const comment = { id: uid("cmt"), userId: myId, text: ct, authorSnapshot: snap, createdAt: nowMs() };
  post.comments.push(comment);
  const notif = pushNotification(db2, post.userId, "comment", myId, { postId: post.id, commentId: comment.id, text: ct.slice(0, 140) });
  await saveDatabase(db2, false, { skipSecondarySync: true });
  if (isTursoConfigured()) {
    await tursoUpsertPosts([post]);
    if (notif) await tursoUpsertNotifications([notif]);
  }
  return c.json({ comment: { ...comment, author: snap || { id: myId, displayName: "Member", username: "member" } } });
});
app.post("/api/posts/delete", requireAuth, async (c) => {
  const { postId } = await c.req.json().catch(() => ({}));
  if (!postId) return c.json({ error: "postId required" }, 400);
  let db2 = await fetchDatabase();
  let p = db2.posts.find((x) => x.id === postId);
  if (!p) {
    cacheTimestamp = 0;
    db2 = await fetchDatabase();
    p = db2.posts.find((x) => x.id === postId);
  }
  if (!p) return c.json({ error: "Not found" }, 404);
  if (p.userId !== c.get("userId")) return c.json({ error: "Forbidden" }, 403);
  p.deletedAt = nowMs();
  await saveDatabase(db2, false, { skipSecondarySync: true });
  if (isTursoConfigured()) await tursoUpsertPosts([p]);
  return c.json({ ok: true, undoUntil: p.deletedAt + 30 * 24 * 3600 * 1e3 });
});
app.post("/api/posts/restore", requireAuth, async (c) => {
  const { postId } = await c.req.json().catch(() => ({}));
  if (!postId) return c.json({ error: "postId required" }, 400);
  let db2 = await fetchDatabase();
  let p = db2.posts.find((x) => x.id === postId);
  if (!p) {
    cacheTimestamp = 0;
    db2 = await fetchDatabase();
    p = db2.posts.find((x) => x.id === postId);
  }
  if (!p) return c.json({ error: "Not found" }, 404);
  if (p.userId !== c.get("userId")) return c.json({ error: "Forbidden" }, 403);
  delete p.deletedAt;
  await saveDatabase(db2, false, { skipSecondarySync: true });
  if (isTursoConfigured()) await tursoUpsertPosts([p]);
  return c.json({ ok: true });
});
app.post("/api/stories/:id/view", requireAuth, async (c) => {
  const postId = c.req.param("id");
  const myId = c.get("userId");
  let db2 = await fetchDatabase();
  let p = db2.posts.find((x) => x.id === postId);
  if (!p) {
    cacheTimestamp = 0;
    db2 = await fetchDatabase();
    p = db2.posts.find((x) => x.id === postId);
  }
  if (!p || !isStoryRecord(p)) return c.json({ error: "Story not found" }, 404);
  if (!canViewerSeeStory(p, myId, db2)) return c.json({ error: "Forbidden" }, 403);
  if (p.userId === myId) return c.json({ ok: true, viewCount: (p.views || []).length });
  p.views = Array.isArray(p.views) ? p.views : [];
  const existing = p.views.find((v) => v.userId === myId);
  if (existing) {
    existing.at = nowMs();
  } else {
    p.views.push({ userId: myId, at: nowMs() });
  }
  await saveDatabase(db2, true);
  if (isTursoConfigured()) await tursoUpsertPosts([p]);
  return c.json({ ok: true, viewCount: p.views.length });
});
app.get("/api/stories/:id/viewers", requireAuth, async (c) => {
  const postId = c.req.param("id");
  const myId = c.get("userId");
  const db2 = await fetchDatabase();
  const p = db2.posts.find((x) => x.id === postId);
  if (!p || !isStoryRecord(p)) return c.json({ error: "Story not found" }, 404);
  if (p.userId !== myId) return c.json({ error: "Forbidden" }, 403);
  const views = (Array.isArray(p.views) ? p.views : []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  const viewers = views.map((v) => {
    const u = db2.users.find((x) => x.id === v.userId);
    const su = u ? sanitizeUser(u) : { id: v.userId, displayName: "Member", username: (v.userId || "m").slice(-6), photoUrl: "" };
    return { ...su, at: v.at || 0 };
  });
  return c.json({ viewers, viewCount: viewers.length });
});
app.post("/api/stories/:id/reply", requireAuth, async (c) => {
  const postId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const myId = c.get("userId");
  const emoji = typeof body.emoji === "string" ? body.emoji.slice(0, 8) : "";
  const text = sanitizeText(body.text || "", 500).trim();
  if (!emoji && !text) return c.json({ error: "Empty reply" }, 400);
  let db2 = await fetchDatabase();
  let p = db2.posts.find((x) => x.id === postId);
  if (!p) {
    cacheTimestamp = 0;
    db2 = await fetchDatabase();
    p = db2.posts.find((x) => x.id === postId);
  }
  if (!p || !isStoryRecord(p)) return c.json({ error: "Story not found" }, 404);
  if (p.userId === myId) return c.json({ error: "Cannot reply to your own story" }, 400);
  if (!canViewerSeeStory(p, myId, db2)) return c.json({ error: "Forbidden" }, 403);
  const roomId = dmRoomFor(myId, p.userId);
  const author = db2.users.find((u) => u.id === myId);
  const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || "" } : null;
  const storyRef = {
    id: p.id,
    kind: "story",
    imageUrl: Array.isArray(p.images) && p.images[0] || p.imageUrl || null,
    text: typeof p.text === "string" ? p.text.slice(0, 120) : "",
    username: p.authorSnapshot && p.authorSnapshot.username || ""
  };
  const bodyText = emoji ? text ? emoji + " " + text : emoji : text;
  const msg = {
    id: uid("msg"),
    roomId,
    userId: myId,
    text: bodyText,
    imageUrl: null,
    storyReply: storyRef,
    replyTo: null,
    authorSnapshot: snap,
    createdAt: nowMs()
  };
  db2.messages.push(msg);
  const enriched = { ...msg, author: snap || { id: myId, displayName: "Member", username: "member" } };
  _pushEvent(p.userId, "new_message", { roomId, message: enriched });
  const notif = pushNotification(db2, p.userId, "story_reply", myId, { text: bodyText.slice(0, 80), postId: p.id });
  const persisted = await saveDatabaseVerified(db2, (d) => (d.messages || []).some((m) => m.id === msg.id), 4, { skipSecondarySync: true });
  if (isPersist() && !persisted) return c.json({ error: "Reply storage unavailable. Please retry." }, 503);
  if (isTursoConfigured()) {
    await tursoUpsertMessages([msg]);
    if (notif) await tursoUpsertNotifications([notif]);
    await tursoRefreshDmIndexForOwners(db2, roomId.slice(3).split(":").filter(Boolean));
  }
  return c.json({ ok: true, message: enriched });
});
app.all("/api/admin/*", (c) => c.json({ error: "Admin panel removed" }, 404));
app.get("/api/push/vapid-public", (c) => c.json({ key: VAPID_PUBLIC || "" }));
app.post("/api/push/subscribe", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { subscription } = body;
  if (!isValidPushSubscription(subscription)) return c.json({ error: "Invalid subscription" }, 400);
  const db2 = await fetchDatabase();
  const u = db2.users.find((x) => x.id === c.get("userId"));
  if (!u) return c.json({ error: "Not found" }, 404);
  u.pushSubs = u.pushSubs || [];
  const i = u.pushSubs.findIndex((s) => s.endpoint === subscription.endpoint);
  if (i >= 0) u.pushSubs[i] = subscription;
  else u.pushSubs.push(subscription);
  if (u.pushSubs.length > 5) u.pushSubs = u.pushSubs.slice(-5);
  await saveDatabase(db2, false);
  return c.json({ ok: true, devices: u.pushSubs.length });
});
app.post("/api/push/unsubscribe", requireAuth, async (c) => {
  const { endpoint } = await c.req.json().catch(() => ({}));
  if (!isSafeHttpsUrl(endpoint, 2048)) return c.json({ error: "Invalid endpoint" }, 400);
  const db2 = await fetchDatabase();
  const u = db2.users.find((x) => x.id === c.get("userId"));
  if (!u) return c.json({ error: "Not found" }, 404);
  u.pushSubs = (u.pushSubs || []).filter((s) => s.endpoint !== endpoint);
  await saveDatabase(db2, false);
  return c.json({ ok: true });
});
app.get("/api/stream", async (c) => {
  const token = c.req.query("token") || (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return c.text("", 401);
  let payload;
  try {
    payload = await verifyToken(token);
  } catch (_) {
    return c.text("", 401);
  }
  const authDb = await fetchPrimaryDatabase();
  const authUser = (authDb.users || []).find((u) => u.id === payload.uid);
  if (!authUser || Number(payload.sv || 0) !== Number(authUser.tokenVersion || 0)) return c.text("", 401);
  const userId = payload.uid;
  const lastEventId = c.req.header("last-event-id") || c.req.query("lastEventId") || null;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = /* @__PURE__ */ __name((text) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch (_) {
        }
      }, "send");
      send(": connected\n\n");
      const queue = _eventQueues.get(userId) || [];
      let startIdx = 0;
      if (lastEventId) {
        const i = queue.findIndex((e) => e.id === lastEventId);
        if (i >= 0) startIdx = i + 1;
      }
      for (let i = startIdx; i < queue.length; i++) {
        const e = queue[i];
        send(`id: ${e.id}
event: ${e.kind}
data: ${JSON.stringify(e)}

`);
      }
      const sub = { closed: false, write: send };
      if (!_eventSubscribers.has(userId)) _eventSubscribers.set(userId, /* @__PURE__ */ new Set());
      _eventSubscribers.get(userId).add(sub);
      const heartbeat = setInterval(() => {
        try {
          send(": ping\n\n");
        } catch (_) {
        }
      }, 1e4);
      let lastSeenTs = Date.now() - 1500;
      const sentIds = /* @__PURE__ */ new Set();
      const primaryPoller = isTursoPrimary() ? setInterval(async () => {
        if (sub.closed) return;
        try {
          let rows = [];
          await tursoEnsure();
          const rs = await tursoClient().execute({
            sql: `SELECT id, kind, data, created_at FROM ps_events
                  WHERE (user_id = ? OR user_id = ?) AND created_at > ?
                  ORDER BY created_at ASC LIMIT 30`,
            args: [userId, "__ALL__", lastSeenTs]
          });
          rows = rs.rows || [];
          for (const r of rows || []) {
            const ts = Number(r.created_at);
            if (ts > lastSeenTs) lastSeenTs = ts;
            if (!sentIds.has(r.id)) {
              sentIds.add(r.id);
              const payloadStr = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
              send(`id: ${r.id}
event: ${r.kind}
data: ${payloadStr}

`);
            }
          }
          if (Math.random() < 0.03) {
            const oldTs = Date.now() - 3e5;
            tursoClient().execute({ sql: "DELETE FROM ps_events WHERE created_at < ?", args: [oldTs] }).catch(() => {
            });
          }
        } catch (_) {
        }
      }, 1500) : null;
      const autoclose = setTimeout(() => cleanup(), 24e3);
      function cleanup() {
        if (sub.closed) return;
        sub.closed = true;
        clearInterval(heartbeat);
        if (primaryPoller) clearInterval(primaryPoller);
        clearTimeout(autoclose);
        const set = _eventSubscribers.get(userId);
        if (set) {
          set.delete(sub);
          if (set.size === 0) _eventSubscribers.delete(userId);
        }
        try {
          controller.close();
        } catch (_) {
        }
      }
      __name(cleanup, "cleanup");
      c.req.raw.signal.addEventListener("abort", cleanup);
    }
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
});
var cf_worker_default = app;
var FEED_FANOUT_THRESHOLD = 5e3;
async function tursoUpsertUserFeeds(userFeeds) {
  if (!isTursoConfigured() || !Array.isArray(userFeeds) || userFeeds.length === 0) return;
  await tursoEnsure();
  const stmts = userFeeds.map((uf) => ({
    sql: `INSERT INTO ps_user_feeds (user_id, post_id, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id, post_id) DO UPDATE SET created_at = excluded.created_at`,
    args: [uf.userId, uf.postId, uf.createdAt]
  }));
  await tursoClient().batch(stmts, "write").catch((e) => console.warn("[turso] user_feeds upsert failed", e?.message));
}
__name(tursoUpsertUserFeeds, "tursoUpsertUserFeeds");
async function getFollowerCount(userId, db2) {
  const user = (db2.users || []).find((u) => u.id === userId);
  return user && Array.isArray(user.followers) ? user.followers.length : 0;
}
__name(getFollowerCount, "getFollowerCount");
async function fanoutPostToFollowers(post, db2) {
  if (!isTursoConfigured()) return;
  const authorId = post.userId;
  const followerCount = await getFollowerCount(authorId, db2);
  if (followerCount > FEED_FANOUT_THRESHOLD) {
    return;
  }
  const author = (db2.users || []).find((u) => u.id === authorId);
  const followers = author && Array.isArray(author.followers) ? author.followers : [];
  if (!followers.length) return;
  const feedRows = followers.map((fid) => ({
    userId: fid,
    postId: post.id,
    createdAt: post.createdAt || nowMs()
  }));
  await tursoUpsertUserFeeds(feedRows);
}
__name(fanoutPostToFollowers, "fanoutPostToFollowers");
app.get("/api/feed", requireAuth, async (c) => {
  const myId = c.get("userId");
  const limit = Math.min(50, Math.max(5, parseInt(c.req.query("limit") || "20")));
  if (!isTursoConfigured()) {
    const db3 = await fetchDatabase();
    const me2 = (db3.users || []).find((u) => u.id === myId);
    const following2 = me2 && Array.isArray(me2.following) ? me2.following : [];
    const allFollowing2 = [...following2, myId];
    const usersById2 = new Map((db3.users || []).map((u) => [u.id, u]));
    const posts2 = (db3.posts || []).filter((p) => !p.deletedAt && allFollowing2.includes(p.userId) && !p.story).sort((a, b) => {
      const engA = (a.likes || []).length * 3 + (a.comments || []).length * 5;
      const engB = (b.likes || []).length * 3 + (b.comments || []).length * 5;
      return (b.createdAt || 0) * 0.7 + engB * 0.3 - ((a.createdAt || 0) * 0.7 + engA * 0.3);
    }).slice(0, limit).map((p) => {
      const liveUser = usersById2.get(p.userId);
      const authorObj = liveUser ? sanitizeUser(liveUser) : p.authorSnapshot || { id: p.userId, displayName: "Member", username: (p.userId || "m").slice(-6) };
      return { ...p, author: authorObj };
    });
    return c.json({ posts: posts2, source: "full-db-fallback" });
  }
  await tursoEnsure();
  const tc = tursoClient();
  const feedRows = await tc.execute({
    sql: `SELECT post_id, created_at FROM ps_user_feeds WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    args: [myId, limit * 2]
  }).catch(() => ({ rows: [] }));
  let postIds = new Set(feedRows.rows?.map((r) => r.post_id) || []);
  const db2 = await fetchDatabase();
  const me = (db2.users || []).find((u) => u.id === myId);
  const following = me && Array.isArray(me.following) ? me.following : [];
  const allFollowing = [...following, myId];
  if (allFollowing.length > 0) {
    const placeholders = allFollowing.map(() => "?").join(",");
    const recentPosts = await tc.execute({
      sql: `SELECT id FROM ps_posts WHERE user_id IN (${placeholders}) AND (story IS NULL OR story = 0) AND (deleted_at IS NULL OR deleted_at = 0) ORDER BY created_at DESC LIMIT ?`,
      args: [...allFollowing, limit]
    }).catch(() => ({ rows: [] }));
    recentPosts.rows?.forEach((r) => postIds.add(r.id));
  }
  const finalPostIds = Array.from(postIds).slice(0, limit);
  if (!finalPostIds.length) return c.json({ posts: [] });
  const idPlaceholders = finalPostIds.map(() => "?").join(",");
  const postData = await tc.execute({
    // ps_user_feeds (the pre-fanned push-model table) is not pruned when a
    // post is deleted, so a since-deleted post's id can still show up in
    // postIds above. Filter deleted_at here too as a second safety net —
    // don't rely solely on the two upstream queries already excluding it.
    sql: `SELECT data_json FROM ps_posts WHERE id IN (${idPlaceholders}) AND (deleted_at IS NULL OR deleted_at = 0)`,
    args: finalPostIds
  }).catch(() => ({ rows: [] }));
  const usersById = new Map((db2.users || []).map((u) => [u.id, u]));
  const posts = postData.rows?.map((r) => {
    try {
      return JSON.parse(r.data_json);
    } catch {
      return null;
    }
  }).filter(Boolean).filter((p) => !p.deletedAt).map((p) => {
    const liveUser = usersById.get(p.userId);
    const authorObj = liveUser ? sanitizeUser(liveUser) : p.authorSnapshot || { id: p.userId, displayName: "Member", username: (p.userId || "m").slice(-6) };
    return { ...p, author: authorObj };
  }).sort((a, b) => {
    const engA = (a.likes || []).length * 3 + (a.comments || []).length * 5;
    const engB = (b.likes || []).length * 3 + (b.comments || []).length * 5;
    const scoreA = (a.createdAt || 0) * 0.7 + engA * 0.3;
    const scoreB = (b.createdAt || 0) * 0.7 + engB * 0.3;
    return scoreB - scoreA;
  });
  return c.json({ posts, source: "hybrid-turso-feed" });
});
app.all("/api/*", (c) => c.json({ error: "Route not found", path: c.req.path }, 404));

// _worker.js
function isBlockedAssetPath(pathname) {
  if (!pathname || pathname === "/") return false;
  const exact = /* @__PURE__ */ new Set([
    "/README.md",
    "/THIRD_PARTY_API_AUDIT.md",
    "/SECURITY_AUDIT_2026-07-02.md",
    "/package.json",
    "/package-lock.json",
    "/wrangler.toml",
    "/dev-server.js",
    "/.cloudflareignore",
    "/.vercelignore"
  ]);
  if (exact.has(pathname)) return true;
  return pathname.startsWith("/backups/") || pathname.startsWith("/scripts/") || pathname.startsWith("/SECURITY_AUDIT") || pathname.startsWith("/.git") || pathname.startsWith("/.github/");
}
__name(isBlockedAssetPath, "isBlockedAssetPath");
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return cf_worker_default.fetch(request, env, ctx);
    }
    if (isBlockedAssetPath(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  }
};
export {
  worker_default as default
};
/*! Bundled license information:

bcryptjs/dist/bcrypt.js:
  (**
   * @license bcrypt.js (c) 2013 Daniel Wirtz <dcode@dcode.io>
   * Released under the Apache License, Version 2.0
   * see: https://github.com/dcodeIO/bcrypt.js for details
   *)
*/
