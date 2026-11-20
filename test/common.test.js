const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

test("CSV export preserves Excel text, commas, quotes and UTF-8 BOM", () => {
  const created = {};
  class TestUrl extends URL {
    static createObjectURL(blob) { created.blob = blob; return "blob:test"; }
    static revokeObjectURL(url) { created.revoked = url; }
  }
  const context = vm.createContext({
    Blob: class {
      constructor(parts, options) {
        this.parts = parts;
        this.type = options.type;
      }
    },
    URL: TestUrl,
    window: { location: { href: "http://localhost/shan/login.html" } },
    localStorage: { getItem() { return null; }, setItem() {} },
    document: {
      documentElement: { dataset: {} },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      addEventListener() {},
      body: { append() {} },
      createElement(tag) {
        assert.equal(tag, "a");
        return {
          click() { created.filename = this.download; },
          remove() {}
        };
      }
    },
    setTimeout(callback) { created.revoke = callback; }
  });
  const commonJs = fs.readFileSync(path.join(__dirname, "..", "public", "common.js"), "utf8");
  vm.runInContext(commonJs, context);

  vm.runInContext("downloadCsv", context)(
    "residents.csv",
    ["Student ID", "Name"],
    [["000123", "A, B"], ["000456", 'A "Quoted"'], ["000789", "=SUM(1,2)"]]
  );

  assert.equal(created.filename, "residents.csv");
  assert.equal(created.blob.type, "text/csv;charset=utf-8");
  assert.equal(created.blob.parts.join(""), '\uFEFF"Student ID","Name"\r\n"000123","A, B"\r\n"000456","A ""Quoted"""\r\n"000789","\'=SUM(1,2)"');
  assert.equal(created.revoked, undefined);
  created.revoke();
  assert.equal(created.revoked, "blob:test");
});

test("shared formatters preserve pesos and parse timestamp strings", () => {
  const context = vm.createContext({
    URL,
    window: { location: { href: "http://localhost/shan/index.html" } },
    document: {
      documentElement: { dataset: {} },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      addEventListener() {}
    },
    localStorage: { getItem() { return null; }, setItem() {} }
  });
  const commonJs = fs.readFileSync(path.join(__dirname, "..", "public", "common.js"), "utf8");
  vm.runInContext(commonJs, context);

  assert.equal(vm.runInContext("peso(1250)", context), "₱1,250");
  assert.match(vm.runInContext('formatDate("1763312400000")', context), /2025/);
  assert.doesNotMatch(vm.runInContext('formatDateTime("1763312400000")', context), /Invalid Date/);
});
