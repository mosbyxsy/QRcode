/**
 * 码上 QR Studio 的全部前端业务逻辑。
 * 页面不依赖服务端：二维码、图片和解析结果仅存在于当前浏览器内存中。
 */
(() => {
  "use strict";

  // 文件大小和画布边长限制用于防止超大图片造成浏览器内存峰值。
  const MAX_DECODE_FILE_SIZE = 12 * 1024 * 1024;
  const MAX_LOGO_FILE_SIZE = 2 * 1024 * 1024;
  const MAX_DECODE_EDGE = 2048;
  const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  const IMAGE_EXTENSION_PATTERN = /\.(png|jpe?g|webp|gif)$/i;

  /** 在指定根节点中查询第一个匹配元素。 */
  const $ = (selector, root = document) => root.querySelector(selector);
  /** 在指定根节点中查询全部匹配元素，并转换为普通数组。 */
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  // 缓存页面元素，避免事件处理和实时渲染过程中重复查询 DOM。
  const elements = {
    generatorForm: $("#generator-form"),
    content: $("#qr-content"),
    contentCount: $("#content-count"),
    clearContent: $("#clear-content"),
    contentError: $("#content-error"),
    size: $("#qr-size"),
    sizeValue: $("#qr-size-value"),
    previewSize: $("#preview-size-note"),
    errorLevel: $("#error-level"),
    dotStyle: $("#dot-style"),
    cornerSquareStyle: $("#corner-square-style"),
    cornerDotStyle: $("#corner-dot-style"),
    foreground: $("#foreground-color"),
    foregroundHex: $("#foreground-hex"),
    gradientStart: $("#gradient-start"),
    gradientStartHex: $("#gradient-start-hex"),
    gradientEnd: $("#gradient-end"),
    gradientEndHex: $("#gradient-end-hex"),
    gradientAngle: $("#gradient-angle"),
    gradientAngleValue: $("#gradient-angle-value"),
    gradientAngleGroup: $("#gradient-angle-group"),
    solidControls: $("#solid-color-controls"),
    gradientControls: $("#gradient-color-controls"),
    background: $("#background-color"),
    backgroundHex: $("#background-hex"),
    margin: $("#qr-margin"),
    marginValue: $("#qr-margin-value"),
    logoInput: $("#logo-input"),
    logoSelect: $("#logo-select"),
    logoRemove: $("#logo-remove"),
    logoFileName: $("#logo-file-name"),
    logoSummary: $("#logo-summary"),
    logoSizeGroup: $("#logo-size-group"),
    logoSize: $("#logo-size"),
    logoSizeValue: $("#logo-size-value"),
    qrCanvas: $("#qr-canvas"),
    qrEmpty: $("#qr-empty"),
    generationStatus: $("#generation-status"),
    generationStatusCopy: $("#generation-status .status-copy"),
    downloadPng: $("#download-png"),
    downloadSvg: $("#download-svg"),
    decodeInput: $("#decode-input"),
    dropzone: $("#decode-dropzone"),
    decodePreviewWrap: $("#decode-preview-wrap"),
    decodeCanvas: $("#decode-canvas"),
    decodeFileName: $("#decode-file-name"),
    decodeReplace: $("#decode-replace"),
    decodeStatus: $("#decode-status"),
    decodeResult: $("#decode-result"),
    resultType: $("#result-type"),
    resultTitle: $("#result-title"),
    resultFields: $("#result-fields"),
    rawContent: $("#raw-content"),
    copyRaw: $("#copy-raw"),
    resultActions: $("#result-actions"),
    toast: $("#toast")
  };

  // 只保存当前会话需要的临时状态，不写入 localStorage 或其他持久化介质。
  const state = {
    qr: null,
    logoData: "",
    generationTimer: 0,
    generationToken: 0,
    toastTimer: 0,
    lastDecodedRaw: ""
  };

  /** 检查离线依赖、绑定事件并创建首个二维码实例。 */
  function init() {
    if (typeof window.QRCodeStyling !== "function" || typeof window.jsQR !== "function") {
      setGenerationStatus("warning", "二维码组件未能载入，请确认 vendor 目录完整。", true);
      setDecodeStatus("error", "组件载入失败", "请确认离线依赖文件与 index.html 位于同一目录。", "!");
      disableDownloads(true);
      return;
    }

    bindGeneratorEvents();
    bindDecoderEvents();
    syncControlLabels();
    toggleColorControls();

    state.qr = new window.QRCodeStyling(buildQrOptions());
    state.qr.append(elements.qrCanvas);
    scheduleGeneration(120);
  }

  /** 绑定生成器输入、清空、Logo 和下载相关事件。 */
  function bindGeneratorEvents() {
    elements.generatorForm.addEventListener("submit", (event) => event.preventDefault());
    elements.generatorForm.addEventListener("input", (event) => {
      if (event.target === elements.logoInput) return;
      syncControlLabels();
      if (event.target.name === "color-mode") toggleColorControls();
      scheduleGeneration();
    });
    elements.generatorForm.addEventListener("change", (event) => {
      if (event.target === elements.logoInput) return;
      syncControlLabels();
      if (event.target.name === "color-mode") toggleColorControls();
      scheduleGeneration(80);
    });

    elements.logoSelect.addEventListener("click", () => elements.logoInput.click());
    elements.clearContent.addEventListener("click", () => {
      if (!elements.content.value) return;
      elements.content.value = "";
      syncControlLabels();
      scheduleGeneration(0);
      elements.content.focus();
      showToast("内容已清空");
    });
    elements.logoInput.addEventListener("change", () => {
      const [file] = elements.logoInput.files;
      elements.logoInput.value = "";
      if (file) handleLogoFile(file);
    });
    elements.logoRemove.addEventListener("click", removeLogo);
    elements.downloadPng.addEventListener("click", () => downloadQr("png"));
    elements.downloadSvg.addEventListener("click", () => downloadQr("svg"));
  }

  /** 绑定图片选择、键盘、拖放、粘贴和复制结果事件。 */
  function bindDecoderEvents() {
    const openPicker = () => elements.decodeInput.click();
    elements.dropzone.addEventListener("click", openPicker);
    elements.dropzone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openPicker();
      }
    });
    elements.decodeReplace.addEventListener("click", openPicker);
    elements.decodeInput.addEventListener("change", () => {
      const [file] = elements.decodeInput.files;
      elements.decodeInput.value = "";
      if (file) decodeFile(file);
    });

    ["dragenter", "dragover"].forEach((eventName) => {
      elements.dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        elements.dropzone.classList.add("is-dragging");
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      });
    });
    ["dragleave", "drop"].forEach((eventName) => {
      elements.dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        elements.dropzone.classList.remove("is-dragging");
      });
    });
    elements.dropzone.addEventListener("drop", (event) => {
      const [file] = event.dataTransfer?.files || [];
      if (file) decodeFile(file);
    });

    document.addEventListener("paste", (event) => {
      const items = [...(event.clipboardData?.items || [])];
      const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
      if (!imageItem) return;
      const file = imageItem.getAsFile();
      if (!file) return;
      event.preventDefault();
      decodeFile(file, "粘贴的图片");
    });

    elements.copyRaw.addEventListener("click", () => copyText(state.lastDecodedRaw, "原始内容已复制"));
  }

  /** @returns {string} 当前选中的点阵颜色模式。 */
  function selectedColorMode() {
    return $('input[name="color-mode"]:checked')?.value || "solid";
  }

  /** 同步滑块输出值、颜色代码、字符数和清空按钮状态。 */
  function syncControlLabels() {
    elements.contentCount.textContent = `${[...elements.content.value].length} 字符`;
    elements.clearContent.disabled = elements.content.value.length === 0;
    elements.sizeValue.textContent = `${elements.size.value} px`;
    elements.previewSize.textContent = `${elements.size.value} × ${elements.size.value}`;
    elements.marginValue.textContent = `${elements.margin.value} px`;
    elements.logoSizeValue.textContent = `${elements.logoSize.value}%`;
    elements.gradientAngleValue.textContent = `${elements.gradientAngle.value}°`;
    elements.foregroundHex.textContent = elements.foreground.value.toUpperCase();
    elements.gradientStartHex.textContent = elements.gradientStart.value.toUpperCase();
    elements.gradientEndHex.textContent = elements.gradientEnd.value.toUpperCase();
    elements.backgroundHex.textContent = elements.background.value.toUpperCase();
  }

  /** 根据颜色模式显示纯色或渐变参数，并隐藏无效的角度设置。 */
  function toggleColorControls() {
    const mode = selectedColorMode();
    const isSolid = mode === "solid";
    elements.solidControls.hidden = !isSolid;
    elements.gradientControls.hidden = isSolid;
    elements.gradientAngleGroup.hidden = mode === "radial";
  }

  /**
   * 将当前表单值转换为 qr-code-styling 所需的配置对象。
   * @returns {object} 可直接用于创建或更新二维码的配置。
   */
  function buildQrOptions() {
    const size = Number(elements.size.value);
    const colorMode = selectedColorMode();
    const baseStyle = colorMode === "solid"
      ? { color: elements.foreground.value }
      : {
          gradient: {
            type: colorMode,
            rotation: Number(elements.gradientAngle.value) * Math.PI / 180,
            colorStops: [
              { offset: 0, color: elements.gradientStart.value },
              { offset: 1, color: elements.gradientEnd.value }
            ]
          }
        };

    return {
      width: size,
      height: size,
      type: "svg",
      data: elements.content.value,
      image: state.logoData || "",
      margin: Number(elements.margin.value),
      qrOptions: {
        typeNumber: 0,
        mode: "Byte",
        errorCorrectionLevel: elements.errorLevel.value
      },
      dotsOptions: {
        ...baseStyle,
        type: elements.dotStyle.value,
        roundSize: true
      },
      cornersSquareOptions: {
        ...baseStyle,
        type: elements.cornerSquareStyle.value
      },
      cornersDotOptions: {
        ...baseStyle,
        type: elements.cornerDotStyle.value
      },
      backgroundOptions: {
        color: elements.background.value
      },
      imageOptions: {
        hideBackgroundDots: true,
        imageSize: Number(elements.logoSize.value) / 100,
        margin: Math.max(2, Math.round(size * 0.0125)),
        saveAsBlob: true,
        crossOrigin: "anonymous"
      }
    };
  }

  /**
   * 防抖调度二维码重绘，并使用递增令牌使旧的异步验证自动失效。
   * @param {number} delay 重绘前等待的毫秒数。
   */
  function scheduleGeneration(delay = 260) {
    window.clearTimeout(state.generationTimer);
    state.generationToken += 1;
    const token = state.generationToken;
    state.generationTimer = window.setTimeout(() => renderQr(token), delay);
  }

  /**
   * 校验内容、更新二维码预览，并启动可识别性回读。
   * @param {number} token 当前生成任务令牌。
   */
  function renderQr(token = state.generationToken) {
    const content = elements.content.value;
    elements.contentError.textContent = "";

    if (!content.trim()) {
      elements.contentError.textContent = "请输入要生成二维码的内容。";
      elements.qrCanvas.hidden = true;
      elements.qrEmpty.hidden = false;
      disableDownloads(true);
      setGenerationStatus("empty", "等待输入内容。", true);
      return;
    }

    elements.qrCanvas.hidden = false;
    elements.qrEmpty.hidden = true;
    disableDownloads(false);
    setGenerationStatus("checking", "正在验证可识别性…", true);

    try {
      state.qr.update(buildQrOptions());
    } catch (error) {
      handleGenerationError(error);
      return;
    }

    window.setTimeout(() => verifyGeneratedQr(token, content), 320);
  }

  /**
   * 将当前 SVG 栅格化后交给 jsQR 回读，判断样式是否仍可识别。
   * @param {number} token 当前生成任务令牌。
   * @param {string} expectedContent 期望回读出的原始内容。
   * @param {number} attempt 当前重试次数。
   */
  async function verifyGeneratedQr(token, expectedContent, attempt = 0) {
    if (token !== state.generationToken || !elements.content.value.trim()) return;

    try {
      const svg = elements.qrCanvas.querySelector("svg");
      if (!svg) throw new Error("QR preview is not ready");
      const svgSource = new XMLSerializer().serializeToString(svg);
      const blob = new Blob([svgSource], { type: "image/svg+xml;charset=utf-8" });
      if (token !== state.generationToken) return;
      const image = await loadImageFromBlob(blob);
      if (token !== state.generationToken) return;

      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const decoded = window.jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: "attemptBoth"
      });
      if (decoded && decoded.data === expectedContent) {
        const contrast = currentMinimumContrast();
        if (contrast < 3) {
          setGenerationStatus("warning", "当前可以识别，但颜色对比偏低，建议加深点阵颜色。", true);
        } else {
          setGenerationStatus("valid", "验证通过，当前二维码可以正常识别。", true);
        }
      } else if (attempt < 2) {
        window.setTimeout(() => verifyGeneratedQr(token, expectedContent, attempt + 1), 450);
      } else {
        setGenerationStatus("warning", "当前样式可能影响扫描，建议提高对比度或缩小 Logo。", true);
      }
    } catch (error) {
      if (token !== state.generationToken) return;
      setGenerationStatus("warning", "无法自动验证，但仍可下载；建议用手机扫码确认。", true);
    }
  }

  /** 将容量溢出和其他生成异常转换为用户可理解的提示。 */
  function handleGenerationError(error) {
    const message = String(error?.message || error || "");
    const isOverflow = /overflow|too long|code length/i.test(message);
    elements.contentError.textContent = isOverflow
      ? "内容超出当前二维码容量，请缩短内容或降低容错等级。"
      : "生成失败，请检查内容或样式设置。";
    disableDownloads(true);
    setGenerationStatus("warning", "暂时无法生成此二维码。", true);
  }

  /**
   * 更新生成器状态条的颜色类别和文本。
   * @param {string} kind 状态类型，如 checking、valid 或 warning。
   * @param {string} message 展示给用户的状态文本。
   * @param {boolean} replaceClass 是否覆盖现有状态类。
   */
  function setGenerationStatus(kind, message, replaceClass = false) {
    if (replaceClass) elements.generationStatus.className = `status-message is-${kind}`;
    elements.generationStatusCopy.textContent = message;
  }

  /** 同时启用或禁用 PNG、SVG 下载按钮。 */
  function disableDownloads(disabled) {
    elements.downloadPng.disabled = disabled;
    elements.downloadSvg.disabled = disabled;
  }

  /**
   * 使用时间戳文件名导出当前二维码。
   * @param {"png"|"svg"} extension 目标文件格式。
   */
  async function downloadQr(extension) {
    if (!elements.content.value.trim() || !state.qr) return;
    const previousText = extension === "png" ? elements.downloadPng.textContent : elements.downloadSvg.textContent;
    const button = extension === "png" ? elements.downloadPng : elements.downloadSvg;
    button.disabled = true;
    button.textContent = "正在准备…";
    try {
      await state.qr.download({
        name: `qrcode-${timestampForFileName()}`,
        extension
      });
      showToast(`${extension.toUpperCase()} 已开始下载`);
    } catch (error) {
      showToast("下载失败，请稍后重试");
    } finally {
      button.textContent = previousText;
      button.disabled = false;
    }
  }

  /**
   * 校验并读取本地 Logo；添加 Logo 时自动切换到 H 级容错。
   * @param {File} file 用户选择的图片文件。
   */
  function handleLogoFile(file) {
    if (!isSupportedImage(file)) {
      showToast("请选择 PNG、JPG、WebP 或 GIF 图片");
      return;
    }
    if (file.size > MAX_LOGO_FILE_SIZE) {
      showToast("Logo 图片不能超过 2MB");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      state.logoData = String(reader.result || "");
      elements.logoFileName.textContent = file.name || "本地图片";
      elements.logoSummary.textContent = "已添加";
      elements.logoSizeGroup.hidden = false;
      elements.logoRemove.hidden = false;
      if (elements.errorLevel.value !== "H") {
        elements.errorLevel.value = "H";
        showToast("已自动切换为 H 级容错，让 Logo 更易扫描");
      }
      syncControlLabels();
      scheduleGeneration(60);
    };
    reader.onerror = () => showToast("无法读取这张 Logo 图片");
    reader.readAsDataURL(file);
  }

  /** 清除内存中的 Logo 数据并恢复相关控件状态。 */
  function removeLogo() {
    state.logoData = "";
    elements.logoFileName.textContent = "尚未选择";
    elements.logoSummary.textContent = "可选";
    elements.logoSizeGroup.hidden = true;
    elements.logoRemove.hidden = true;
    scheduleGeneration(60);
    showToast("Logo 已移除");
  }

  /** @returns {number} 当前前景色或渐变端点相对背景色的最低对比度。 */
  function currentMinimumContrast() {
    const background = elements.background.value;
    const colors = selectedColorMode() === "solid"
      ? [elements.foreground.value]
      : [elements.gradientStart.value, elements.gradientEnd.value];
    return Math.min(...colors.map((color) => contrastRatio(color, background)));
  }

  /**
   * 按 WCAG 亮度公式计算两个十六进制颜色的对比度。
   * @returns {number} 范围从 1 到 21 的对比度。
   */
  function contrastRatio(first, second) {
    const firstLuminance = relativeLuminance(first);
    const secondLuminance = relativeLuminance(second);
    const lighter = Math.max(firstLuminance, secondLuminance);
    const darker = Math.min(firstLuminance, secondLuminance);
    return (lighter + 0.05) / (darker + 0.05);
  }

  /** @returns {number} 十六进制颜色在线性 RGB 空间中的相对亮度。 */
  function relativeLuminance(hex) {
    const channels = hex.match(/[a-f\d]{2}/gi).map((value) => parseInt(value, 16) / 255);
    const linear = channels.map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  }

  /**
   * 读取图片、缩放到安全尺寸、调用 jsQR，并渲染第一个识别结果。
   * @param {File|Blob} file 待解析的本地图片。
   * @param {string} displayName 粘贴图片等场景使用的替代文件名。
   */
  async function decodeFile(file, displayName = "") {
    elements.decodeResult.hidden = true;
    state.lastDecodedRaw = "";

    if (!isSupportedImage(file)) {
      setDecodeStatus("error", "不支持的文件", "请选择 PNG、JPG、WebP 或 GIF 图片。", "!");
      showToast("这不是受支持的图片格式");
      return;
    }
    if (file.size > MAX_DECODE_FILE_SIZE) {
      setDecodeStatus("error", "图片过大", "请选择不超过 12MB 的图片。", "!");
      showToast("图片不能超过 12MB");
      return;
    }

    elements.dropzone.hidden = true;
    elements.decodePreviewWrap.hidden = true;
    elements.decodeFileName.textContent = displayName || file.name || "本地图片";
    setDecodeStatus("loading", "正在解析", "正在本地读取图片并寻找二维码…", "");

    try {
      const image = await loadImageFromBlob(file);
      drawDecodeImage(image);
      elements.decodePreviewWrap.hidden = false;
      const context = elements.decodeCanvas.getContext("2d", { willReadFrequently: true });
      const imageData = context.getImageData(0, 0, elements.decodeCanvas.width, elements.decodeCanvas.height);
      const code = window.jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: "attemptBoth"
      });

      if (!code) {
        setDecodeStatus("error", "未发现二维码", "请尝试更清晰、对比度更高或留白更完整的图片。", "!");
        return;
      }

      drawDetectionOutline(context, code.location);
      setDecodeStatus("success", "解析成功", "已在图片中找到并读取第一个二维码。", "✓");
      renderDecodedResult(classifyContent(code.data));
    } catch (error) {
      elements.dropzone.hidden = false;
      elements.decodePreviewWrap.hidden = true;
      setDecodeStatus("error", "图片读取失败", "文件可能已损坏，或浏览器不支持它的编码方式。", "!");
    }
  }

  /**
   * 将图片按最大边长等比缩放后绘制到解析 Canvas。
   * @param {HTMLImageElement} image 已完成加载的图片元素。
   */
  function drawDecodeImage(image) {
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const scale = Math.min(1, MAX_DECODE_EDGE / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    elements.decodeCanvas.width = width;
    elements.decodeCanvas.height = height;
    const context = elements.decodeCanvas.getContext("2d", { willReadFrequently: true });
    context.clearRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);
  }

  /**
   * 根据 jsQR 返回的四角坐标，在预览图上绘制绿色定位边框。
   * @param {CanvasRenderingContext2D} context 解析 Canvas 的 2D 上下文。
   * @param {object} location jsQR 返回的定位信息。
   */
  function drawDetectionOutline(context, location) {
    if (!location) return;
    const points = [
      location.topLeftCorner,
      location.topRightCorner,
      location.bottomRightCorner,
      location.bottomLeftCorner
    ];
    context.save();
    context.strokeStyle = "#24d18f";
    context.lineWidth = Math.max(3, Math.round(Math.min(elements.decodeCanvas.width, elements.decodeCanvas.height) / 180));
    context.lineJoin = "round";
    context.shadowColor = "rgba(0, 0, 0, 0.55)";
    context.shadowBlur = context.lineWidth * 1.7;
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
    context.closePath();
    context.stroke();
    context.restore();
  }

  /** 更新解析器的状态类型、标题、说明和辅助图标。 */
  function setDecodeStatus(kind, title, detail, icon) {
    elements.decodeStatus.className = `decode-status is-${kind}`;
    const iconElement = $(".decode-status-icon", elements.decodeStatus);
    const titleElement = $("strong", elements.decodeStatus);
    const detailElement = $(":scope > div > span", elements.decodeStatus);
    iconElement.textContent = icon;
    titleElement.textContent = title;
    detailElement.textContent = detail;
  }

  /**
   * 安全地渲染结构化字段、原始文本和按类型生成的快捷操作。
   * 所有二维码内容均通过 textContent 写入，避免执行不可信标记。
   */
  function renderDecodedResult(result) {
    state.lastDecodedRaw = result.raw;
    elements.resultType.textContent = result.label;
    elements.resultTitle.textContent = result.title;
    elements.rawContent.textContent = result.raw;
    elements.resultFields.replaceChildren();
    elements.resultActions.replaceChildren();

    result.fields.forEach(({ label, value }) => {
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = value || "—";
      elements.resultFields.append(term, description);
    });

    result.actions.forEach((action, index) => {
      let control;
      if (action.href) {
        control = document.createElement("a");
        control.href = action.href;
        control.target = "_blank";
        control.rel = "noopener noreferrer";
      } else {
        control = document.createElement("button");
        control.type = "button";
        if (action.kind === "copy") {
          control.addEventListener("click", () => copyText(action.value, action.successMessage || "内容已复制"));
        } else if (action.kind === "vcard") {
          control.addEventListener("click", () => downloadVCard(result.raw, action.fileName));
        }
      }
      control.className = `action-button${index > 0 ? " is-secondary" : ""}`;
      control.textContent = action.label;
      elements.resultActions.append(control);
    });

    elements.decodeResult.hidden = false;
  }

  /**
   * 识别二维码内容类型，并生成统一的展示模型。
   * @param {unknown} rawValue jsQR 返回的原始值。
   * @returns {{raw:string,label:string,title:string,fields:Array,actions:Array}} 解析结果模型。
   */
  function classifyContent(rawValue) {
    const raw = String(rawValue ?? "");
    const value = raw.trim();
    const base = { raw, fields: [], actions: [] };

    const urlResult = classifyHttpUrl(value, base);
    if (urlResult) return urlResult;

    if (/^WIFI:/i.test(value)) {
      const wifi = parseWifi(value);
      if (wifi?.ssid) {
        const summary = [
          `网络名称：${wifi.ssid}`,
          `加密类型：${wifi.security || "未指定"}`,
          `密码：${wifi.password || "无"}`,
          `隐藏网络：${wifi.hidden ? "是" : "否"}`
        ].join("\n");
        return {
          ...base,
          label: "WI-FI",
          title: "Wi-Fi 网络",
          fields: [
            { label: "网络名称", value: wifi.ssid },
            { label: "加密类型", value: wifi.security || "未指定" },
            { label: "密码", value: wifi.password || "无" },
            { label: "隐藏网络", value: wifi.hidden ? "是" : "否" }
          ],
          actions: [{ kind: "copy", label: "复制网络信息", value: summary, successMessage: "Wi-Fi 信息已复制" }]
        };
      }
    }

    if (/^tel:/i.test(value) && !hasControlCharacters(value)) {
      const number = value.slice(4).trim();
      if (number) {
        return {
          ...base,
          label: "电话",
          title: "电话号码",
          fields: [{ label: "号码", value: number }],
          actions: [{ label: "拨打电话", href: `tel:${number}` }]
        };
      }
    }

    if (/^mailto:/i.test(value) && !hasControlCharacters(value)) {
      const mail = parseMailto(value);
      if (mail.address) {
        const fields = [{ label: "收件人", value: mail.address }];
        if (mail.subject) fields.push({ label: "主题", value: mail.subject });
        return {
          ...base,
          label: "邮件",
          title: "电子邮件",
          fields,
          actions: [{ label: "撰写邮件", href: value }]
        };
      }
    }

    if (/^(sms|smsto):/i.test(value) && !hasControlCharacters(value)) {
      const sms = parseSms(value);
      if (sms.number) {
        const fields = [{ label: "号码", value: sms.number }];
        if (sms.body) fields.push({ label: "短信内容", value: sms.body });
        return {
          ...base,
          label: "短信",
          title: "短信信息",
          fields,
          actions: [{ label: "发送短信", href: value }]
        };
      }
    }

    if (/^geo:/i.test(value)) {
      const geo = parseGeo(value);
      if (geo) {
        const query = `${geo.latitude},${geo.longitude}`;
        return {
          ...base,
          label: "位置",
          title: "地理位置",
          fields: [
            { label: "纬度", value: String(geo.latitude) },
            { label: "经度", value: String(geo.longitude) }
          ],
          actions: [{
            label: "在地图中查看",
            href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
          }]
        };
      }
    }

    if (/^BEGIN:VCARD(?:\r?\n)/i.test(value) && /(?:\r?\n)END:VCARD$/i.test(value)) {
      const card = parseVCard(value);
      if (card.name || card.phone || card.email) {
        const fields = [];
        if (card.name) fields.push({ label: "姓名", value: card.name });
        if (card.organization) fields.push({ label: "组织", value: card.organization });
        if (card.phone) fields.push({ label: "电话", value: card.phone });
        if (card.email) fields.push({ label: "邮箱", value: card.email });
        if (card.address) fields.push({ label: "地址", value: card.address });
        return {
          ...base,
          label: "VCARD",
          title: "联系人名片",
          fields,
          actions: [{ kind: "vcard", label: "下载联系人", fileName: card.name || "contact" }]
        };
      }
    }

    return {
      ...base,
      label: "普通文本",
      title: "文本内容",
      fields: [{ label: "长度", value: `${[...raw].length} 个字符` }],
      actions: []
    };
  }

  /**
   * 仅接受 HTTP/HTTPS 网址，拒绝 javascript 等危险协议。
   * @returns {object|null} 网址结果模型，或在不匹配时返回 null。
   */
  function classifyHttpUrl(value, base) {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return {
        ...base,
        label: "网址",
        title: "网页链接",
        fields: [
          { label: "域名", value: url.hostname },
          { label: "协议", value: url.protocol === "https:" ? "HTTPS（加密）" : "HTTP" }
        ],
        actions: [{ label: "安全打开链接", href: url.href }]
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * 解析 WIFI:S:...;T:... 格式，并正确处理反斜杠转义字段。
   * @returns {{ssid:string,security:string,password:string,hidden:boolean}}
   */
  function parseWifi(value) {
    const body = value.slice(5);
    const fields = {};
    splitUnescaped(body, ";").forEach((segment) => {
      if (!segment) return;
      const [key, rawField] = splitFirstUnescaped(segment, ":");
      if (!key || rawField === undefined) return;
      fields[key.toUpperCase()] = unescapeWifi(rawField);
    });
    return {
      ssid: fields.S || "",
      security: fields.T || "",
      password: fields.P || "",
      hidden: /^(true|1|yes)$/i.test(fields.H || "")
    };
  }

  /** 按未被反斜杠转义的分隔符拆分字符串。 */
  function splitUnescaped(value, delimiter) {
    const result = [];
    let current = "";
    let escaped = false;
    for (const character of value) {
      if (escaped) {
        current += `\\${character}`;
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === delimiter) {
        result.push(current);
        current = "";
      } else {
        current += character;
      }
    }
    if (escaped) current += "\\";
    result.push(current);
    return result;
  }

  /** 在第一个未转义分隔符处分成键和值两部分。 */
  function splitFirstUnescaped(value, delimiter) {
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === delimiter) {
        return [value.slice(0, index), value.slice(index + 1)];
      }
    }
    return [value, undefined];
  }

  /** 还原 Wi-Fi 标准中可被反斜杠转义的特殊字符。 */
  function unescapeWifi(value) {
    return value.replace(/\\([\\;,":])/g, "$1");
  }

  /** 提取 mailto 链接中的收件人和邮件主题。 */
  function parseMailto(value) {
    const body = value.slice(7);
    const [addressPart, query = ""] = body.split("?", 2);
    const params = new URLSearchParams(query);
    return {
      address: safeDecodeURIComponent(addressPart),
      subject: params.get("subject") || ""
    };
  }

  /** 兼容 sms: 和 smsto: 两种常见短信二维码格式。 */
  function parseSms(value) {
    const isSmsto = /^smsto:/i.test(value);
    const body = value.replace(/^(sms|smsto):/i, "");
    if (isSmsto) {
      const separator = body.indexOf(":");
      return separator < 0
        ? { number: body, body: "" }
        : { number: body.slice(0, separator), body: body.slice(separator + 1) };
    }
    const [number, query = ""] = body.split("?", 2);
    return { number, body: new URLSearchParams(query).get("body") || "" };
  }

  /**
   * 解析 geo:纬度,经度，并校验合法坐标范围。
   * @returns {{latitude:number,longitude:number}|null}
   */
  function parseGeo(value) {
    const coordinatePart = value.slice(4).split("?", 1)[0];
    const [latitudeValue, longitudeValue] = coordinatePart.split(",");
    const latitude = Number(latitudeValue);
    const longitude = Number(longitudeValue);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
    return { latitude, longitude };
  }

  /**
   * 展开 vCard 折行并提取常用联系人字段。
   * @returns {{name:string,organization:string,phone:string,email:string,address:string}}
   */
  function parseVCard(value) {
    const unfolded = value.replace(/\r?\n[ \t]/g, "");
    const entries = unfolded.split(/\r?\n/).map((line) => {
      const separator = line.indexOf(":");
      if (separator < 0) return null;
      const rawKey = line.slice(0, separator).split(";", 1)[0].toUpperCase();
      const fieldValue = unescapeVCard(line.slice(separator + 1));
      return [rawKey, fieldValue];
    }).filter(Boolean);
    const firstValue = (key) => entries.find(([entryKey]) => entryKey === key)?.[1] || "";
    return {
      name: firstValue("FN") || firstValue("N").split(";").filter(Boolean).reverse().join(" "),
      organization: firstValue("ORG").replace(/;/g, " · "),
      phone: firstValue("TEL"),
      email: firstValue("EMAIL"),
      address: firstValue("ADR").split(";").filter(Boolean).join(" ")
    };
  }

  /** 还原 vCard 文本中的换行、逗号、分号和反斜杠。 */
  function unescapeVCard(value) {
    return value
      .replace(/\\n/gi, "\n")
      .replace(/\\([\\,;])/g, "$1");
  }

  /** @returns {boolean} 字符串是否包含不适合写入协议链接的控制字符。 */
  function hasControlCharacters(value) {
    return /[\u0000-\u001f\u007f]/.test(value);
  }

  /** 对 URI 片段进行容错解码；格式错误时保留原值。 */
  function safeDecodeURIComponent(value) {
    try {
      return decodeURIComponent(value);
    } catch (error) {
      return value;
    }
  }

  /** 将原始 vCard 内容封装为临时 Blob 并触发 .vcf 下载。 */
  function downloadVCard(raw, name) {
    const blob = new Blob([raw], { type: "text/vcard;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${sanitizeFileName(name)}.vcf`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("联系人文件已开始下载");
  }

  /** 移除 Windows/macOS 文件名中的保留字符并限制名称长度。 */
  function sanitizeFileName(name) {
    return String(name || "contact")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/[. ]+$/g, "")
      .slice(0, 80) || "contact";
  }

  /**
   * 优先使用异步剪贴板 API，失败时回退到兼容复制方案。
   * @param {string} text 需要复制的文本。
   * @param {string} successMessage 复制成功后的提示。
   */
  async function copyText(text, successMessage) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        fallbackCopy(text);
      }
      showToast(successMessage);
    } catch (error) {
      try {
        fallbackCopy(text);
        showToast(successMessage);
      } catch (fallbackError) {
        showToast("复制失败，请手动选择文本");
      }
    }
  }

  /** 使用临时 textarea 和 execCommand 兼容 file:// 等受限环境。 */
  function fallbackCopy(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Copy command failed");
  }

  /** @returns {boolean} 文件 MIME 或扩展名是否属于支持的图片格式。 */
  function isSupportedImage(file) {
    return ALLOWED_IMAGE_TYPES.has(file.type) || (!file.type && IMAGE_EXTENSION_PATTERN.test(file.name || ""));
  }

  /**
   * 通过临时 Object URL 加载 Blob，并在成功或失败后及时释放 URL。
   * @returns {Promise<HTMLImageElement>}
   */
  function loadImageFromBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Image load failed"));
      };
      image.src = url;
    });
  }

  /** @returns {string} 适合作为下载文件名后缀的本地时间戳。 */
  function timestampForFileName() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  /** 显示全局轻提示，并在 2.6 秒后自动隐藏。 */
  function showToast(message) {
    window.clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    state.toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 2600);
  }

  // DOM 与 defer 脚本均已就绪，启动应用。
  init();
})();
