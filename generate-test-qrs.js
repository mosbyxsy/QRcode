"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const QRCodeStyling = require("./vendor/qr-code-styling.js");
const jsQR = require("./vendor/jsQR.js");

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = {};
    this.children = [];
    this.innerHTML = "";
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

class FakeDocument {
  createElementNS(_namespace, tagName) {
    return new FakeElement(tagName);
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }
}

class FakeXMLSerializer {
  serializeToString() {
    return "";
  }
}

class FakeJSDOM {
  constructor() {
    this.window = {
      document: new FakeDocument(),
      XMLSerializer: FakeXMLSerializer,
      Image: class {},
      XMLHttpRequest: class {},
      FileReader: class {}
    };
  }
}

const cases = [
  {
    file: "01-url.png",
    type: "网址",
    data: "https://example.com/qr-test?source=codex"
  },
  {
    file: "02-wifi.png",
    type: "Wi-Fi",
    data: "WIFI:T:WPA;S:QR-Test-WiFi;P:TestPass123!;H:false;;"
  },
  {
    file: "03-phone.png",
    type: "电话",
    data: "tel:+8613800138000"
  },
  {
    file: "04-email.png",
    type: "邮件",
    data: "mailto:qr-test@example.com?subject=QR%20Test&body=Hello%20from%20QR%20code"
  },
  {
    file: "05-sms.png",
    type: "短信",
    data: "SMSTO:+8613800138000:QR code test message"
  },
  {
    file: "06-geo.png",
    type: "地理位置",
    data: "geo:31.2304,121.4737"
  },
  {
    file: "07-vcard.png",
    type: "vCard",
    data: [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:张;三;;;",
      "FN:张三",
      "ORG:二维码测试实验室",
      "TEL;TYPE=CELL:+8613800138000",
      "EMAIL:qr-test@example.com",
      "URL:https://example.com",
      "ADR;TYPE=WORK:;;测试路100号;上海市;上海市;200000;中国",
      "END:VCARD"
    ].join("\r\n")
  }
];

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function encodeGrayscalePng(width, height, pixels) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width + 1);
    raw[rowOffset] = 0;
    pixels.copy(raw, rowOffset + 1, y * width, (y + 1) * width);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function createMatrix(data) {
  const qr = new QRCodeStyling({
    jsdom: FakeJSDOM,
    type: "svg",
    width: 512,
    height: 512,
    data,
    margin: 0,
    qrOptions: { errorCorrectionLevel: "M" },
    dotsOptions: { type: "square", color: "#000000" },
    backgroundOptions: { color: "#ffffff" }
  });
  return qr._qr;
}

function renderQrPng(data, size = 512, quietZone = 4) {
  const matrix = createMatrix(data);
  const modules = matrix.getModuleCount();
  const totalModules = modules + quietZone * 2;
  const scale = Math.floor(size / totalModules);
  const qrPixels = totalModules * scale;
  const offset = Math.floor((size - qrPixels) / 2);
  const pixels = Buffer.alloc(size * size, 255);

  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (!matrix.isDark(row, column)) continue;
      const startX = offset + (column + quietZone) * scale;
      const startY = offset + (row + quietZone) * scale;
      for (let y = 0; y < scale; y += 1) {
        pixels.fill(0, (startY + y) * size + startX, (startY + y) * size + startX + scale);
      }
    }
  }

  return { png: encodeGrayscalePng(size, size, pixels), pixels, size };
}

function decodePixels(pixels, size) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let index = 0; index < pixels.length; index += 1) {
    const value = pixels[index];
    const rgbaIndex = index * 4;
    rgba[rgbaIndex] = value;
    rgba[rgbaIndex + 1] = value;
    rgba[rgbaIndex + 2] = value;
    rgba[rgbaIndex + 3] = 255;
  }
  return jsQR(rgba, size, size, { inversionAttempts: "dontInvert" });
}

const outputDir = path.join(__dirname, "test-qrcodes");
fs.mkdirSync(outputDir, { recursive: true });

for (const testCase of cases) {
  const rendered = renderQrPng(testCase.data);
  const decoded = decodePixels(rendered.pixels, rendered.size);
  if (!decoded || decoded.data !== testCase.data) {
    throw new Error(`Self-check failed for ${testCase.file}`);
  }
  fs.writeFileSync(path.join(outputDir, testCase.file), rendered.png);
}

fs.writeFileSync(
  path.join(outputDir, "manifest.json"),
  `${JSON.stringify(cases, null, 2)}\n`,
  "utf8"
);

console.log(`Generated ${cases.length} QR test images in ${outputDir}`);
