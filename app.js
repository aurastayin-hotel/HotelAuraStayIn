const CONFIG = {
  demoEmail: "abc@gmail.com",
  demoPassword: "Ab@12",
  rooms: 9,
  saveWebhookUrl: "https://script.google.com/macros/s/AKfycbzezxgI0SxN5EiWGIE1J81VPe558QKRgx1-w0SxAcZQmp7Zbmu06rpLEP0f3AId2Iio/exec",
  resetWebhookUrl: "",
  admins: {
    "Praful@gmail.com": "Praful@12345",
    "Rakesh@gmail.com": "Rakesh@12345",
    "Akshay@gmail.com": "Akshay@12345"
  },
  roomList: [
    { number: "101", name: "Room 101", type: "AC" },
    { number: "102", name: "Room 102", type: "AC" },
    { number: "103", name: "Room 103", type: "Non-AC" },
    { number: "201", name: "Room 201", type: "AC" },
    { number: "202", name: "Room 202", type: "AC" },
    { number: "203", name: "Room 203", type: "Non-AC" },
    { number: "204", name: "Room 204", type: "Non-AC" },
    { number: "205", name: "Room 205", type: "Non-AC" },
    { number: "Hall", name: "Hall For Celebration", type: "Hall" }
  ]
};

const $ = id => document.getElementById(id);

async function postWebhook(url, payload) {
  if (!url) return { ok: true };
  try {
    await fetch(url, {
      method: "POST",
      mode: "no-cors",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(payload)
    });
    return { ok: true };
  } catch (error) {
    throw new Error("Unable to connect to server.");
  }
}

function getRoomType(roomNumber) {
  const found = CONFIG.roomList.find(r => String(r.number) === String(roomNumber));
  return found ? found.type : "Standard";
}

function getRoomDisplayName(roomNumber) {
  const found = CONFIG.roomList.find(r => String(r.number) === String(roomNumber));
  return found ? found.name : `Room ${roomNumber}`;
}

/* Safe LocalStorage Reader */
function safeGetStorage(key, fallback = []) {
  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : fallback;
  } catch (e) {
    return fallback;
  }
}

/* Smart Deduplication Helper (Guarantees 0 Duplicates per Room) */
function deduplicateClients(records) {
  if (!Array.isArray(records)) return [];

  const uniqueMap = new Map();

  records.forEach(c => {
    if (!c || typeof c !== "object") return;
    const room = String(c.room || "").trim();
    if (!room) return;

    const guestId = String(c.hisAadhar || c.hisMobile || c.hisName || "").trim().toLowerCase().replace(/[^a-z0-9]/g, '');

    let key;
    if (c.status === "Occupied") {
      key = `OCCUPIED_ROOM_${room}`;
    } else {
      const dateKey = String(c.checkinDateFormatted || c.checkinDate || c.date || "").trim();
      key = `CHECKOUT_ROOM_${room}_${guestId}_${dateKey}`;
    }

    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, c);
    } else {
      const existing = uniqueMap.get(key);
      if (c.checkinDateTime && (!existing.checkinDateTime || c.checkinDateTime > existing.checkinDateTime)) {
        uniqueMap.set(key, c);
      }
    }
  });

  return Array.from(uniqueMap.values());
}

let authenticatedAdmin = sessionStorage.getItem("roomflow_admin") || null;
let clients = deduplicateClients(safeGetStorage("roomflow_clients", []));
let pendingSync = safeGetStorage("roomflow_pending_sync", []);
let staffList = safeGetStorage("roomflow_staff_list", []);
let attendanceRecords = safeGetStorage("roomflow_attendance_records", {});
let syncedAttendanceRecords = safeGetStorage("roomflow_synced_attendance", {});
let pendingAttendanceChanges = safeGetStorage("roomflow_pending_attendance_changes", {});
let pricingRules = safeGetStorage("roomflow_pricing_rules", []);

let confirmCallback = null;
let lastPopupType = "";
let countdownInterval = null;
let isResetFlowActive = false;
let pendingAdminAction = null;
let targetStaffIdForAction = null;
let targetPriceRuleIndexForAction = null;
let isSyncing = false;

try {
  localStorage.setItem("roomflow_clients", JSON.stringify(clients));
} catch (e) { }

function getToday() {
  return new Date().toISOString().slice(0, 10);
}
const today = getToday();

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

/* Real-Time Price Calculation */
function calculateFinalPrice() {
  const amountInput = $("amount");
  const discountInput = $("discount");
  const additionalChargesInput = $("additionalCharges");
  const finalPriceInput = $("finalPrice");

  if (!amountInput || !finalPriceInput) return;

  const amount = parseFloat(amountInput.value) || 0;
  const discount = parseFloat(discountInput?.value) || 0;
  const additionalCharges = parseFloat(additionalChargesInput?.value) || 0;

  const finalPrice = Math.max(0, amount + additionalCharges - discount);
  finalPriceInput.value = amount > 0 ? finalPrice : "";
}

function formatDurationDisplay(val) {
  if (val === null || val === undefined || val === "") return "-";
  let str = String(val).trim();
  if (str.includes("1900-01-")) {
    const match = str.match(/1900-01-0?(\d+)/);
    if (match) return match[1];
  }
  if (str.includes("T")) {
    const d = new Date(str);
    if (!Number.isNaN(d.getTime())) return d.getDate();
  }
  const num = Number(str);
  return !Number.isNaN(num) && num > 0 ? num : str;
}

function formatAmountDisplay(amountVal, finalPriceVal) {
  let val = finalPriceVal ?? amountVal;
  if (typeof val === "string") {
    if (val.includes("T") || Number.isNaN(Number(val))) {
      val = amountVal && !String(amountVal).includes("T") && !Number.isNaN(Number(amountVal)) ? amountVal : 0;
    }
  }
  const num = Number(val);
  return Number.isFinite(num) ? num : 0;
}

function formatDateTimeDisplay(dateStr, timeStr, isoStr) {
  if (isoStr && typeof isoStr === "string" && isoStr.includes("T")) {
    try {
      const d = new Date(isoStr);
      if (!Number.isNaN(d.getTime()) && d.getFullYear() > 1990) {
        const datePart = d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
        const timePart = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
        return `${datePart}, ${timePart}`;
      }
    } catch (e) { }
  }

  if (dateStr && dateStr !== "-" && dateStr !== "") {
    let formattedDate = dateStr;
    try {
      const d = new Date(dateStr);
      if (!Number.isNaN(d.getTime()) && d.getFullYear() > 1990) {
        formattedDate = d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
      }
    } catch (e) { }

    if (timeStr && timeStr !== "-" && timeStr !== "" && !timeStr.includes("-")) {
      return `${formattedDate}, ${timeStr}`;
    }
    return formattedDate;
  }

  return "-";
}

function parseDateTimeFallback(dateStr, timeStr) {
  if (!dateStr || dateStr === "-") return null;
  if (timeStr && timeStr !== "-" && !timeStr.includes("-")) {
    const dCombined = new Date(`${dateStr} ${timeStr}`);
    if (!Number.isNaN(dCombined.getTime())) return dCombined;
  }
  const dDateOnly = new Date(dateStr);
  return !Number.isNaN(dDateOnly.getTime()) ? dDateOnly : null;
}

/* Continuous Offline Sync Worker */
async function syncPendingData() {
  if (isSyncing || !navigator.onLine || !CONFIG.saveWebhookUrl) return;

  pendingSync = safeGetStorage("roomflow_pending_sync", []);
  if (pendingSync.length === 0) return;

  isSyncing = true;
  const remaining = [];

  for (const item of pendingSync) {
    try {
      await postWebhook(CONFIG.saveWebhookUrl, item);
    } catch (err) {
      remaining.push(item);
    }
  }

  pendingSync = remaining;
  localStorage.setItem("roomflow_pending_sync", JSON.stringify(pendingSync));
  isSyncing = false;
}

window.addEventListener("online", syncPendingData);
setInterval(syncPendingData, 10000);

/* AUDIO & VOICEOVER NOTIFICATION SYSTEM */
let voiceoverLoopInterval = null;

function playNotificationChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, ctx.currentTime);
    gain1.gain.setValueAtTime(0.3, ctx.currentTime);
    gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(ctx.currentTime);
    osc1.stop(ctx.currentTime + 0.3);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, ctx.currentTime + 0.15);
    gain2.gain.setValueAtTime(0.4, ctx.currentTime + 0.15);
    gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(ctx.currentTime + 0.15);
    osc2.stop(ctx.currentTime + 0.6);
  } catch (e) {
    console.warn("Unable to play chime:", e);
  }
}

function playVoiceoverNotification() {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();

  const messageText = "Stay duration is completed. Please call the client to inform them that their time is up.";
  const utterance = new SpeechSynthesisUtterance(messageText);

  utterance.rate = 0.95;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;
  utterance.lang = 'en-US';

  window.speechSynthesis.speak(utterance);
}

function startContinuousVoiceoverAlert() {
  stopContinuousVoiceoverAlert();

  playNotificationChime();
  setTimeout(() => {
    playVoiceoverNotification();
  }, 400);

  voiceoverLoopInterval = setInterval(() => {
    playNotificationChime();
    setTimeout(() => {
      playVoiceoverNotification();
    }, 400);
  }, 7000);
}

function stopContinuousVoiceoverAlert() {
  if (voiceoverLoopInterval) {
    clearInterval(voiceoverLoopInterval);
    voiceoverLoopInterval = null;
  }
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

/* Custom Popup System */
function showPopup(type, title, message, onConfirm = null) {
  lastPopupType = type;
  confirmCallback = onConfirm;

  const overlay = $("roomflowPopupOverlay");
  const icon = $("popupIcon");
  const popupTitle = $("popupTitle");
  const popupMessage = $("popupMessage");
  const okButton = $("popupOkBtn");
  const cancelButton = $("popupCancelBtn");

  if (!overlay) {
    if (onConfirm) {
      if (window.confirm(`${title}\n\n${message}`)) onConfirm();
    } else alert(`${title}\n\n${message}`);
    return;
  }

  popupTitle.textContent = title;
  popupMessage.textContent = message;

  if (type === "success") {
    icon.textContent = "✓";
    icon.className = "popup-icon success-icon";
    okButton.textContent = "OK";
    okButton.className = "popup-ok-btn success-ok";
    if (cancelButton) cancelButton.classList.add("hidden");
  } else if (type === "warning") {
    icon.textContent = "⚠";
    icon.className = "popup-icon error-icon";
    okButton.textContent = onConfirm ? "Proceed" : "OK";
    okButton.className = "popup-ok-btn error-ok";
    if (cancelButton) cancelButton.classList.remove("hidden");
  } else {
    icon.textContent = "✕";
    icon.className = "popup-icon error-icon";
    okButton.textContent = "OK";
    okButton.className = "popup-ok-btn error-ok";
    if (cancelButton) cancelButton.classList.add("hidden");
  }

  if (title === "Countdown Expired!") {
    startContinuousVoiceoverAlert();
  }

  overlay.classList.remove("hidden");
  setTimeout(() => okButton.focus(), 50);
}

function closePopup() {
  stopContinuousVoiceoverAlert();

  const overlay = $("roomflowPopupOverlay");
  if (overlay) overlay.classList.add("hidden");

  const cancelButton = $("popupCancelBtn");
  if (cancelButton) cancelButton.classList.add("hidden");

  if (lastPopupType === "success" && $("clientsSection") && !$("clientsSection").classList.contains("hidden")) {
    navigate("dashboard");
  }
}

/* Admin Visibility */
function updateAdminVisibility() {
  const isAdmin = Boolean(authenticatedAdmin || sessionStorage.getItem("roomflow_admin"));
  const btn = $("roomPriceNavBtn");
  if (btn) btn.classList.toggle("hidden", !isAdmin);

  const staffBtn = $("staffAttendanceNavBtn");
  if (staffBtn) staffBtn.classList.toggle("hidden", !isAdmin);
}

/* Navigation & App Views */
function showApp() {
  if ($("loginView")) $("loginView").classList.add("hidden");
  if ($("appView")) $("appView").classList.remove("hidden");

  if ($("todayLabel")) {
    $("todayLabel").textContent = new Date().toLocaleDateString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric"
    });
  }

  if ($("date")) $("date").value = today;

  updateAdminVisibility();
  render();
  startCountdownTimer();
  syncPendingData();
  initAttendanceSelectors();
}

function showLogin() {
  if ($("appView")) $("appView").classList.add("hidden");
  if ($("loginView")) $("loginView").classList.remove("hidden");
}

function navigate(section) {
  const isAdmin = Boolean(authenticatedAdmin || sessionStorage.getItem("roomflow_admin"));
  if ((section === "roomPrice" || section === "staffAttendance") && !isAdmin) {
    showPopup("error", "Access Denied", "Only Admin users can access this section.");
    return;
  }

  closePriceModal();
  closeStaffModal();
  if ($("guestDetailsModal")) $("guestDetailsModal").classList.add("hidden");

  if ($("dashboardSection")) $("dashboardSection").classList.toggle("hidden", section !== "dashboard");
  if ($("clientsSection")) $("clientsSection").classList.toggle("hidden", section !== "clients");
  if ($("guestListSection")) $("guestListSection").classList.toggle("hidden", section !== "guestList");
  if ($("roomPriceSection")) $("roomPriceSection").classList.toggle("hidden", section !== "roomPrice");
  if ($("staffAttendanceSection")) $("staffAttendanceSection").classList.toggle("hidden", section !== "staffAttendance");

  if ($("pageTitle")) {
    if (section === "dashboard") $("pageTitle").textContent = "Dashboard";
    else if (section === "clients") $("pageTitle").textContent = "New Client";
    else if (section === "guestList") $("pageTitle").textContent = "Guest List";
    else if (section === "roomPrice") $("pageTitle").textContent = "Room Price Settings";
    else if (section === "staffAttendance") $("pageTitle").textContent = "Staff Attendance";
  }

  document.querySelectorAll(".nav-item").forEach(button => {
    button.classList.toggle("active", button.dataset.section === section);
  });

  if (section === "clients") {
    if ($("date")) $("date").value = today;
    render();
  } else if (section === "guestList") {
    renderGuestList();
  } else if (section === "roomPrice") {
    renderPricingTable();
  } else if (section === "staffAttendance") {
    renderStaffAttendanceSheet();
  } else if (section === "dashboard") {
    render();
    startCountdownTimer();
  }
}

/* Remembered Login Helper */
function loadRememberedLogin() {
  try {
    const remember = localStorage.getItem("roomflow_remember_login");
    if (remember !== "1") return;

    const savedEmail = localStorage.getItem("roomflow_saved_email");
    const savedPassword = localStorage.getItem("roomflow_saved_password");

    if ($("loginEmail") && savedEmail) $("loginEmail").value = savedEmail;
    if ($("loginPassword") && savedPassword) $("loginPassword").value = savedPassword;

    const checkbox = $("rememberPassword");
    if (checkbox) checkbox.checked = true;
  } catch (e) { }
}

/* Admin Auth Modal */
function authenticateAdmin(username, password) {
  if (CONFIG.admins[username] && CONFIG.admins[username] === password) {
    authenticatedAdmin = username;
    sessionStorage.setItem("roomflow_admin", username);
    updateAdminVisibility();
    return true;
  }
  return false;
}

function openGuestLogin() {
  const guestLoginOverlay = $("guestLoginOverlay");
  if (!guestLoginOverlay) return;

  guestLoginOverlay.classList.add("active");
  if ($("guestLoginForm")) $("guestLoginForm").reset();
  if ($("guestLoginMsg")) {
    $("guestLoginMsg").textContent = "";
    $("guestLoginMsg").style.color = "";
  }

  setTimeout(() => {
    if ($("guestUsername")) $("guestUsername").focus();
  }, 300);
}

function closeGuestLogin() {
  const guestLoginOverlay = $("guestLoginOverlay");
  if (guestLoginOverlay) guestLoginOverlay.classList.remove("active");
  if ($("guestLoginForm")) $("guestLoginForm").reset();
  pendingAdminAction = null;
  targetStaffIdForAction = null;
  targetPriceRuleIndexForAction = null;
}

/* Reset Dashboard */
function masterResetDashboard() {
  showPopup(
    "warning",
    "Reset Dashboard",
    "Are you sure you want to reset the dashboard?\n\nThis will check out all active occupied rooms, record current check-out timestamps, and set room status to Available.",
    () => {
      isResetFlowActive = true;
      openGuestLogin();
    }
  );
}

async function executeMasterReset(adminUsername) {
  const resetNow = new Date();
  const checkoutDateTime = resetNow.toISOString();
  const checkoutDateFormatted = resetNow.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  const checkoutTimeFormatted = resetNow.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });

  let updatedCount = 0;

  clients.forEach(client => {
    if (client.status === "Occupied") {
      client.status = "Checked Out";
      client.checkoutDateTime = checkoutDateTime;
      client.checkoutDateFormatted = checkoutDateFormatted;
      client.checkoutTimeFormatted = checkoutTimeFormatted;
      client.checkoutDate = checkoutDateFormatted;
      client.checkoutTime = checkoutTimeFormatted;
      updatedCount++;
    }
  });

  localStorage.setItem("roomflow_clients", JSON.stringify(clients));

  const resetPayload = {
    action: "reset",
    checkoutDate: checkoutDateFormatted,
    checkoutTime: checkoutTimeFormatted,
    checkoutDateTime: checkoutDateTime,
    resetBy: adminUsername
  };

  try {
    if (navigator.onLine) await postWebhook(CONFIG.saveWebhookUrl, resetPayload);
    else {
      pendingSync.push(resetPayload);
      localStorage.setItem("roomflow_pending_sync", JSON.stringify(pendingSync));
    }
  } catch (e) {
    pendingSync.push(resetPayload);
    localStorage.setItem("roomflow_pending_sync", JSON.stringify(pendingSync));
  }

  render();
  navigate("dashboard");

  showPopup(
    "success",
    "Dashboard Reset Successfully",
    `The dashboard has been reset by ${adminUsername}.\n\n${updatedCount > 0 ? `${updatedCount} occupied room(s) checked out with current timestamp.` : 'All rooms were already available.'}\nAll ${CONFIG.rooms} rooms are now Available.`
  );
}

/* COUNTDOWN & OVERTIME LOGIC */
let notifiedExpiredRooms = new Set();

function formatCountdown(milliseconds) {
  const totalSeconds = Math.floor(Math.abs(milliseconds) / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(" ");
}

function getCheckoutTime(client) {
  let start = null;
  if (client.checkinDateTime) start = new Date(client.checkinDateTime);
  if (!start || Number.isNaN(start.getTime())) {
    start = parseDateTimeFallback(
      client.checkinDateFormatted || client.checkinDate || client.date,
      client.checkinTimeFormatted || client.checkinTime
    );
  }
  if (!start || Number.isNaN(start.getTime())) return null;

  const durationNum = Number(formatDurationDisplay(client.duration));
  if (!durationNum || Number.isNaN(durationNum) || durationNum <= 0) return null;

  const unit = String(client.durationUnit || client.timeUnit || "Hour").toLowerCase();
  let milliseconds = (unit === "day" || unit === "days")
    ? durationNum * 24 * 60 * 60 * 1000
    : durationNum * 60 * 60 * 1000;

  return new Date(start.getTime() + milliseconds);
}

function getClientCountdown(client) {
  const checkout = getCheckoutTime(client);
  if (!checkout) return { text: "No countdown", isOverdue: false, remainingMs: 0 };

  // Calculate reference time: for Checked Out guests use logged checkout time, for Occupied guests use Date.now()
  let refTime = Date.now();
  if (client.status === "Checked Out") {
    if (client.checkoutDateTime) {
      const d = new Date(client.checkoutDateTime);
      if (!Number.isNaN(d.getTime())) refTime = d.getTime();
    } else {
      const dFallback = parseDateTimeFallback(
        client.checkoutDateFormatted || client.checkoutDate,
        client.checkoutTimeFormatted || client.checkoutTime
      );
      if (dFallback && !Number.isNaN(dFallback.getTime())) {
        refTime = dFallback.getTime();
      }
    }
  }

  const remaining = checkout.getTime() - refTime;

  if (remaining <= 0) {
    return {
      text: `⚠️ Overtime: +${formatCountdown(remaining)}`,
      isOverdue: true,
      remainingMs: remaining
    };
  }

  return {
    text: `⏳ ${formatCountdown(remaining)}`,
    isOverdue: false,
    remainingMs: remaining
  };
}

function getCountdownClass(client) {
  const checkout = getCheckoutTime(client);
  if (!checkout) return "";
  const remaining = checkout.getTime() - Date.now();
  if (remaining <= 0) return "expired";
  if (remaining <= 60 * 60 * 1000) return "warning";
  return "active";
}

function updateCountdowns() {
  document.querySelectorAll(".countdown-display").forEach(element => {
    const room = element.dataset.room;
    const client = clients.find(item => String(item.room) === String(room) && item.status === "Occupied");
    if (!client) return;

    const countdownInfo = getClientCountdown(client);
    element.textContent = countdownInfo.text;
    const status = getCountdownClass(client);

    element.classList.remove("active", "warning", "expired");
    if (status) element.classList.add(status);

    if (countdownInfo.isOverdue && !notifiedExpiredRooms.has(String(room))) {
      notifiedExpiredRooms.add(String(room));
      const roomDisplayName = getRoomDisplayName(room);

      showPopup(
        "warning",
        "Countdown Expired!",
        `${roomDisplayName} stay duration has completed.\n\nOvertime counter is now active so you can track how much extra time the guest has taken for checkout.`
      );
    }
  });
}

function startCountdownTimer() {
  if (countdownInterval) clearInterval(countdownInterval);
  updateCountdowns();
  countdownInterval = setInterval(updateCountdowns, 1000);
}

/* Room Release */
function releaseRoom(roomNumber) {
  const index = clients.findIndex(client => String(client.room) === String(roomNumber) && client.status === "Occupied");
  const roomDisplayName = getRoomDisplayName(roomNumber);

  if (index === -1) {
    showPopup("error", "Room Already Available", `${roomDisplayName} does not have an active client.`);
    return;
  }

  showPopup(
    "warning",
    "Room Checkout",
    `${roomDisplayName}\n\nRoom key received?\n\nClick Proceed only after the room key has been received.`,
    async () => {
      stopContinuousVoiceoverAlert();

      const checkoutNow = new Date();
      const checkoutDateTime = checkoutNow.toISOString();
      const checkoutDateFormatted = checkoutNow.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
      const checkoutTimeFormatted = checkoutNow.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });

      clients[index].status = "Checked Out";
      clients[index].checkoutDateTime = checkoutDateTime;
      clients[index].checkoutDateFormatted = checkoutDateFormatted;
      clients[index].checkoutTimeFormatted = checkoutTimeFormatted;
      clients[index].checkoutDate = checkoutDateFormatted;
      clients[index].checkoutTime = checkoutTimeFormatted;

      localStorage.setItem("roomflow_clients", JSON.stringify(clients));
      notifiedExpiredRooms.delete(String(roomNumber));

      const client = clients[index];
      if (!client.id) {
        client.id = "RF_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
      }
      const roomType = getRoomType(roomNumber);
      const formattedRoom = String(roomNumber).toLowerCase() === "hall" || String(roomNumber).toLowerCase().includes("hall") ? roomDisplayName : `${roomNumber} (${roomType})`;

      const payload = {
        action: "checkout",
        targetSheet: "Clients",
        id: client.id,

        "Sr No": client.srNo || (index + 1),
        "His Name 👦🏻": client.hisName || "-",
        "His Mobile": client.hisMobile || "-",
        "His Aadhaar Card Number": client.hisAadhar || "-",
        "Her Name 👧🏻": client.herName || "-",
        "Her Mobile": client.herMobile || "-",
        "Her Aadhaar Card Number": client.herAadhar || "-",
        "Amount": client.finalPrice || client.amount || 0,
        "Mode of Payment": client.paymentMode || "-",
        "Check-In-Date": client.checkinDateFormatted || client.checkinDate || "-",
        "Check-In-Time": client.checkinTimeFormatted || client.checkinTime || "-",
        "Alloted Room Number": formattedRoom,
        "Time Duration": client.duration || "-",
        "Hour / Day": client.durationUnit || client.timeUnit || "Hour",
        "Check-Out-Date": checkoutDateFormatted,
        "Check-Out-Time": checkoutTimeFormatted,

        srNo: client.srNo || (index + 1),
        hisName: client.hisName || "-",
        hisMobile: client.hisMobile || "-",
        hisAadhar: client.hisAadhar || "-",
        hisAadhaar: client.hisAadhar || "-",
        herName: client.herName || "-",
        herMobile: client.herMobile || "-",
        herAadhar: client.herAadhar || "-",
        herAadhaar: client.herAadhar || "-",
        amount: client.finalPrice || client.amount || 0,
        finalPrice: client.finalPrice || client.amount || 0,
        paymentMode: client.paymentMode || "-",
        checkinDate: client.checkinDateFormatted || client.checkinDate || "-",
        checkinDateFormatted: client.checkinDateFormatted || client.checkinDate || "-",
        checkinTime: client.checkinTimeFormatted || client.checkinTime || "-",
        checkinTimeFormatted: client.checkinTimeFormatted || client.checkinTime || "-",
        allotedRoomNumber: formattedRoom,
        allottedRoom: formattedRoom,
        room: formattedRoom,
        roomNumber: roomNumber,
        roomDisplayName: roomDisplayName,
        roomType: roomType,
        duration: client.duration || "-",
        durationUnit: client.durationUnit || client.timeUnit || "Hour",
        checkoutDate: checkoutDateFormatted,
        checkoutDateFormatted: checkoutDateFormatted,
        checkoutTime: checkoutTimeFormatted,
        checkoutTimeFormatted: checkoutTimeFormatted,
        checkoutDateTime: checkoutDateTime,
        status: "Checked Out"
      };

      try {
        if (navigator.onLine) await postWebhook(CONFIG.saveWebhookUrl, payload);
        else {
          pendingSync.push(payload);
          localStorage.setItem("roomflow_pending_sync", JSON.stringify(pendingSync));
        }
      } catch (e) {
        pendingSync.push(payload);
        localStorage.setItem("roomflow_pending_sync", JSON.stringify(pendingSync));
      }

      render();

      showPopup(
        "success",
        "Room Available",
        `${roomDisplayName} is now available again.\n\nCheck-out Date & Time: ${checkoutDateFormatted}, ${checkoutTimeFormatted}`
      );
    }
  );
}

/* Dashboard Render */
function render() {
  if (!$("roomGrid")) return;

  clients = deduplicateClients(clients);

  const occupied = new Map();

  clients.filter(client => client.status === "Occupied").forEach(client => {
    occupied.set(String(client.room), client);

    if (client.includeFreeHall && String(client.room) !== "Hall") {
      occupied.set("Hall", {
        ...client,
        isFreeHallReservation: true,
        mainRoomNumber: client.room
      });
    }
  });

  const totalCount = CONFIG.roomList ? CONFIG.roomList.length : CONFIG.rooms;

  if ($("totalRooms")) $("totalRooms").textContent = totalCount;
  if ($("occupiedRooms")) $("occupiedRooms").textContent = occupied.size;
  if ($("availableRooms")) $("availableRooms").textContent = totalCount - occupied.size;
  if ($("occupancyRate")) $("occupancyRate").textContent = Math.round((occupied.size / totalCount) * 100) + "%";

  $("roomGrid").innerHTML = CONFIG.roomList.map((roomItem, index) => {
    const roomNumber = roomItem.number;
    const roomDisplayName = roomItem.name;
    const roomType = roomItem.type;
    const client = occupied.get(String(roomNumber));

    if (client) {
      const countdownInfo = getClientCountdown(client);
      const countdownClass = getCountdownClass(client);
      let guestCount = (client.hisName && client.herName) ? 2 : 1;
      const displayDuration = formatDurationDisplay(client.duration);

      const isFreeHall = client.isFreeHallReservation;
      const stateLabel = isFreeHall ? `Free w/ ${getRoomDisplayName(client.mainRoomNumber)}` : "Occupied";
      const subtitleText = isFreeHall ? `🎉 Free Birthday Hall` : (guestCount === 2 ? "Guest 1 + Guest 2" : "Guest 1");

      return `
        <div class="room-card occupied" style="animation-delay:${index * 35}ms">
          <div class="room-top">
            <span class="room-number">${escapeHtml(roomDisplayName)}</span>
            <span class="room-state" style="${isFreeHall ? 'background:rgba(140,92,255,0.25);color:#b080ff;' : ''}">${stateLabel}</span>
          </div>
          <div style="margin-top:18px;font-size:12px;color:#91a2b7;font-weight:600;">
            ${escapeHtml(roomType.toUpperCase())} ${roomType.toLowerCase().includes('hall') ? '' : 'ROOM'}
          </div>
          <div class="room-client">
            ${subtitleText}
          </div>
          <div class="room-sub countdown-display ${countdownClass}" data-room="${escapeHtml(roomNumber)}">
            ${escapeHtml(countdownInfo.text)}
          </div>
          <div class="room-sub" style="margin-top:7px;">
            ${displayDuration ? `${escapeHtml(displayDuration)} ${escapeHtml(client.durationUnit || client.timeUnit || "Hour")}` : "Duration not set"}
          </div>
          ${isFreeHall
          ? `<div style="margin-top:16px;font-size:11px;color:#b080ff;text-align:center;font-weight:600;">Linked to ${escapeHtml(getRoomDisplayName(client.mainRoomNumber))}</div>`
          : `<button type="button" class="ghost-btn room-key-btn" style="margin-top:16px;width:100%;font-size:11px;padding:9px 10px;" data-room-release="${escapeHtml(roomNumber)}">☑ Checkout</button>`
        }
          <div class="room-glow"></div>
        </div>
      `;
    }

    return `
      <div class="room-card" style="animation-delay:${index * 35}ms">
        <div class="room-top">
          <span class="room-number">${escapeHtml(roomDisplayName)}</span>
          <span class="room-state">Available</span>
        </div>
        <div style="margin-top:18px;font-size:12px;color:#91a2b7;font-weight:600;">
          ${escapeHtml(roomType.toUpperCase())} ${roomType.toLowerCase().includes('hall') ? '' : 'ROOM'}
        </div>
        <div class="room-client">
          Ready to allot
        </div>
        <div class="room-sub">
          No active guest
        </div>
        <div class="room-glow"></div>
      </div>
    `;
  }).join("");

  document.querySelectorAll("[data-room-release]").forEach(button => {
    button.addEventListener("click", () => {
      const room = button.dataset.roomRelease;
      releaseRoom(room);
    });
  });

  if ($("room")) {
    const options = CONFIG.roomList.map(roomItem => {
      const roomNumber = roomItem.number;
      const roomDisplayName = roomItem.name;
      const type = roomItem.type;
      const taken = occupied.has(String(roomNumber));

      return `
        <option value="${escapeHtml(roomNumber)}" ${taken ? "disabled" : ""}>
          ${escapeHtml(roomDisplayName)} - ${escapeHtml(type)}${taken ? " — Occupied/Reserved" : ""}
        </option>
      `;
    }).join("");

    $("room").innerHTML = `
      <option value="">Select an available room</option>
      ${options}
    `;
  }

  updateCountdowns();
}

/* Form Validation */
function validateClientForm() {
  const fields = [
    { id: "date", name: "Today's Date" },
    { id: "room", name: "Allotted Room Number" },
    { id: "hisName", name: "His Name" },
    { id: "herName", name: "Her Name" },
    { id: "hisMobile", name: "His Mobile" },
    { id: "hisAadhar", name: "His Aadhar Card Number" },
    { id: "herAadhar", name: "Her Aadhar Card Number" },
    { id: "amount", name: "Amount" },
    { id: "paymentMode", name: "Mode of Payment" },
    { id: "duration", name: "Time" },
    { id: "durationUnit", name: "Hour or Day" }
  ];

  fields.forEach(field => {
    if ($(field.id)) $(field.id).classList.remove("invalid");
  });
  if ($("herMobile")) $("herMobile").classList.remove("invalid");

  for (const field of fields) {
    const element = $(field.id);
    if (!element) continue;

    if (!String(element.value).trim()) {
      element.classList.add("invalid");
      element.focus();
      showPopup("error", "Required Field Missing", `Please enter/select "${field.name}".`);
      return false;
    }

    if (!element.checkValidity()) {
      element.classList.add("invalid");
      element.focus();

      let message = `Please enter a valid ${field.name}.`;
      if (field.id === "hisMobile") {
        message = "His Mobile must contain exactly 10 digits.";
      } else if (field.id === "hisAadhar") {
        message = "His Aadhar Card Number must contain exactly 12 digits.";
      } else if (field.id === "herAadhar") {
        message = "Her Aadhar Card Number must contain exactly 12 digits.";
      }

      showPopup("error", "Invalid Field", message);
      return false;
    }
  }

  const herMobileEl = $("herMobile");
  if (herMobileEl && herMobileEl.value.trim() !== "") {
    if (herMobileEl.value.trim().length !== 10) {
      herMobileEl.classList.add("invalid");
      herMobileEl.focus();
      showPopup("error", "Invalid Field", "Her Mobile must contain exactly 10 digits if entered.");
      return false;
    }
  }

  return true;
}

/* Guest List Render */
async function renderGuestList() {
  const container = $("guestList");
  if (!container) return;

  const currentAdmin = authenticatedAdmin || sessionStorage.getItem("roomflow_admin");
  if (!currentAdmin) {
    container.innerHTML = `<div class="form-msg" style="text-align:center;padding:20px;">Guest List access required. Please sign in with an Admin account (Praful / Rakesh / Akshay) to view records.</div>`;
    return;
  }

  authenticatedAdmin = currentAdmin;
  container.innerHTML = `<div class="form-msg" style="text-align:center;padding:20px;">⏳ Loading guest records...</div>`;

  if (CONFIG.saveWebhookUrl && navigator.onLine) {
    try {
      const response = await fetch(CONFIG.saveWebhookUrl);
      const cloudData = await response.json();
      if (Array.isArray(cloudData) && cloudData.length > 0) {
        const rawCloud = cloudData.map(c => ({
          ...c,
          amount: formatAmountDisplay(c.amount, c.finalPrice),
          duration: formatDurationDisplay(c.duration),
          status: c.status || ((c.checkoutDateFormatted && c.checkoutDateFormatted !== "-") || (c.checkoutDate && c.checkoutDate !== "-") ? "Checked Out" : "Occupied")
        }));
        clients = deduplicateClients([...clients, ...rawCloud]);
        localStorage.setItem("roomflow_clients", JSON.stringify(clients));
      }
    } catch (err) {
      console.warn("Using local cached records:", err);
    }
  }

  clients = deduplicateClients(clients);

  if (clients.length === 0) {
    container.innerHTML = `<div class="form-msg" style="text-align:center;padding:20px;">No guest records found in database.</div>`;
    return;
  }

  const rowsHtml = clients.map((client, index) => {
    const displayDuration = formatDurationDisplay(client.duration);
    const checkinDisplay = formatDateTimeDisplay(
      client.checkinDateFormatted || client.checkinDate || client.date,
      client.checkinTimeFormatted || client.checkinTime,
      client.checkinDateTime
    );
    const checkoutDisplay = (client.status === "Occupied" || (!client.checkoutDateTime && (!client.checkoutDateFormatted || client.checkoutDateFormatted === "-")))
      ? "Active (In Stay)"
      : formatDateTimeDisplay(client.checkoutDateFormatted || client.checkoutDate, client.checkoutTimeFormatted || client.checkoutTime, client.checkoutDateTime);

    const safeAmount = formatAmountDisplay(client.amount, client.finalPrice);
    const freeHallBadge = client.includeFreeHall ? ' <span style="color:#b080ff;font-weight:700;">(🎉 Free Hall)</span>' : '';

    return `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(client.hisName || "-")}</td>
        <td>${escapeHtml(client.hisMobile || "-")}</td>
        <td>${escapeHtml(client.hisAadhar || "-")}</td>
        <td>${escapeHtml(client.herName || "-")}</td>
        <td>${escapeHtml(client.herMobile || "-")}</td>
        <td>${escapeHtml(client.herAadhar || "-")}</td>
        <td>₹${escapeHtml(safeAmount)}</td>
        <td>${escapeHtml(client.paymentMode || "-")}</td>
        <td>${escapeHtml(getRoomDisplayName(client.room))} (${escapeHtml(client.roomType || getRoomType(client.room))})${freeHallBadge}</td>
        <td>${escapeHtml(displayDuration || "-")} ${escapeHtml(client.durationUnit || client.timeUnit || "Hour")}</td>
        <td>${escapeHtml(checkinDisplay)}</td>
        <td>${escapeHtml(checkoutDisplay)}</td>
        <td><span style="padding:4px 8px;border-radius:12px;font-size:11px;font-weight:700;background:${client.status === "Occupied" ? "rgba(255,107,122,0.15)" : "rgba(53,211,154,0.15)"};color:${client.status === "Occupied" ? "#ff6b7a" : "#35d39a"};">${escapeHtml(client.status || "Occupied")}</span></td>
        <td>
          <button type="button" class="primary-btn" style="padding:6px 14px;font-size:11px;" data-view-client="${index}">View 👁</button>
        </td>
      </tr>
    `;
  }).join("");

  container.innerHTML = `
    <div style="overflow-x: auto;">
      <table class="guest-table">
        <thead>
          <tr>
            <th>Sr No</th>
            <th>His Name 👦🏻</th>
            <th>His Mobile</th>
            <th>His Aadhaar</th>
            <th>Her Name 👧🏻</th>
            <th>Her Mobile</th>
            <th>Her Aadhaar</th>
            <th>Amount Paid</th>
            <th>Payment Mode</th>
            <th>Allotted Room</th>
            <th>Duration</th>
            <th>Check-in Date & Time 🕒</th>
            <th>Check-out Date & Time 🚪</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;

  container.querySelectorAll("[data-view-client]").forEach(button => {
    button.addEventListener("click", () => viewClientDetails(Number(button.dataset.viewClient)));
  });
}

function viewClientDetails(index) {
  const client = clients[index];
  if (!client) return;

  const content = $("guestDetailsContent");
  if (!content) return;

  const displayDuration = formatDurationDisplay(client.duration);
  const checkinDisplay = formatDateTimeDisplay(
    client.checkinDateFormatted || client.checkinDate || client.date,
    client.checkinTimeFormatted || client.checkinTime,
    client.checkinDateTime
  );
  const checkoutDisplay = (client.status === "Occupied" || (!client.checkoutDateTime && (!client.checkoutDateFormatted || client.checkoutDateFormatted === "-")))
    ? "Active (In Stay)"
    : formatDateTimeDisplay(client.checkoutDateFormatted || client.checkoutDate, client.checkoutTimeFormatted || client.checkoutTime, client.checkoutDateTime);

  const safeAmount = formatAmountDisplay(client.amount, client.finalPrice);
  
  // Compute overtime details for this specific guest
  const countdownInfo = getClientCountdown(client);

  // Render Overtime field ONLY if overtime counter has started / overdue
  const overtimeHtml = countdownInfo.isOverdue
    ? `<small style="color: var(--muted); display: block; margin-bottom: 3px; margin-top: 10px;">Overtime</small>
       <strong style="color: #ff4d4d;"> +${escapeHtml(formatCountdown(countdownInfo.remainingMs))} ⚠️ </strong>`
    : '';

  content.innerHTML = `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 13px;">
      <div style="background: rgba(255,255,255,.04); padding: 12px; border-radius: 12px; border: 1px solid var(--border);">
        <small style="color: var(--muted); display: block; margin-bottom: 3px;">Room Allotted</small>
        <strong>${escapeHtml(getRoomDisplayName(client.room))} (${escapeHtml(client.roomType || getRoomType(client.room))})</strong>
        ${client.includeFreeHall ? '<div style="color:#b080ff;font-weight:600;font-size:11px;margin-top:4px;">🎉 Free Birthday Celebration Hall Reserved</div>' : ''}
      </div>
      <div style="background: rgba(255,255,255,.04); padding: 12px; border-radius: 12px; border: 1px solid var(--border);">
        <small style="color: var(--muted); display: block; margin-bottom: 3px;">Status</small>
        <strong style="color: ${client.status === "Occupied" ? "#ff6b7a" : "#35d39a"};">${escapeHtml(client.status || "Occupied")}</strong>
      </div>
      <div style="background: rgba(255,255,255,.04); padding: 12px; border-radius: 12px; border: 1px solid var(--border);">
        <small style="color: var(--muted); display: block; margin-bottom: 3px;">Check-in Date & Time 🕒</small>
        <strong>${escapeHtml(checkinDisplay)}</strong>
      </div>
      <div style="background: rgba(255,255,255,.04); padding: 12px; border-radius: 12px; border: 1px solid var(--border);">
        <small style="color: var(--muted); display: block; margin-bottom: 3px;">Check-out Date & Time 🚪</small>
        <strong>${escapeHtml(checkoutDisplay)}</strong>
      </div>
      <div style="background: rgba(255,255,255,.04); padding: 12px; border-radius: 12px; border: 1px solid var(--border);">
        <small style="color: var(--muted); display: block; margin-bottom: 3px;">Stay Duration</small>
        <strong>${escapeHtml(displayDuration || "-")} ${escapeHtml(client.durationUnit || client.timeUnit || "Hour")}</strong>
        
        ${overtimeHtml}
      </div>
      
      <div style="background: rgba(255,255,255,.04); padding: 12px; border-radius: 12px; border: 1px solid var(--border);"> 
        <small style="color: var(--muted); display: block; margin-bottom: 8px;"> Amount Paid </small> 
        <div style="font-size: 13px; color: #d8e1ee; font-weight: 700; margin-bottom: 8px;"> ₹${escapeHtml(safeAmount)} (${escapeHtml(client.paymentMode || "-")}) </div> 
      
        <div style="font-size: 10px; color: #d8e1ee; display: flex; justify-content: space-between; align-items: center; margin-top: 8px;"> 
          <span>Discount (₹)</span> 
          <span style="font-weight: 200;">${escapeHtml(client.discount || 0)} ₹</span> 
        </div> 
      
        <div style="font-size: 10px; color: #d8e1ee; display: flex; justify-content: space-between; align-items: center; margin-top: 6px;"> 
          <span>Additional Charges (₹)</span> 
          <span style="font-weight: 200;">${escapeHtml(client.additionalCharges || 0)} ₹</span> 
        </div> 
      </div>

      <div style="grid-column: 1 / -1; background: rgba(255,255,255,.04); padding: 14px; border-radius: 12px; border: 1px solid var(--border);">
        <strong style="color: #8ea7ff; display: block; margin-bottom: 8px;">His Details 👦🏻</strong>
        <div><strong>Name:</strong> ${escapeHtml(client.hisName || "-")}</div>
        <div><strong>Mobile:</strong> ${escapeHtml(client.hisMobile || "-")}</div>
        <div><strong>Aadhaar:</strong> ${escapeHtml(client.hisAadhar || "-")}</div>
      </div>
      <div style="grid-column: 1 / -1; background: rgba(255,255,255,.04); padding: 14px; border-radius: 12px; border: 1px solid var(--border);">
        <strong style="color: #8ea7ff; display: block; margin-bottom: 8px;">Her Details 👧🏻</strong>
        <div><strong>Name:</strong> ${escapeHtml(client.herName || "-")}</div>
        <div><strong>Mobile:</strong> ${escapeHtml(client.herMobile || "-")}</div>
        <div><strong>Aadhaar:</strong> ${escapeHtml(client.herAadhar || "-")}</div>
      </div>
    </div>
  `;

  const modal = $("guestDetailsModal");
  if (modal) modal.classList.remove("hidden");
}

/* Dynamic Room Price Management */
function savePricingRules() {
  localStorage.setItem("roomflow_pricing_rules", JSON.stringify(pricingRules));
}

function parseHoursRange(hoursStr) {
  const str = String(hoursStr || "").trim();
  if (str.includes("-")) {
    const parts = str.split("-").map(p => parseFloat(p.trim()));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      return { minHours: parts[0], maxHours: parts[1] };
    }
  }
  if (str.endsWith("+")) {
    const val = parseFloat(str.replace("+", "").trim());
    if (!isNaN(val)) return { minHours: val, maxHours: 99999 };
  }
  const val = parseFloat(str);
  if (!isNaN(val)) return { minHours: val, maxHours: val };
  return { minHours: 0, maxHours: 0 };
}

function renderPricingTable() {
  const tbody = $("priceRulesTableBody");
  if (!tbody) return;

  if (pricingRules.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:24px; color:#91a2b7;">No room price rules added yet. Click "+ Add Price Rule" above to add custom pricing.</td></tr>`;
    return;
  }

  tbody.innerHTML = pricingRules.map((rule, idx) => `
    <tr style="border-bottom: 1px solid rgba(255,255,255,0.08);">
      <td style="text-align: center; padding: 14px 12px; font-weight: 600; color: #aebbd0;">${idx + 1}</td>
      <td style="text-align: left; padding: 14px 12px;">
        <span style="display: inline-block; padding: 4px 10px; border-radius: 8px; font-size: 12px; font-weight: 700; background: ${rule.roomType === 'AC' ? 'rgba(113,140,255,0.15)' : 'rgba(53,211,154,0.15)'}; color: ${rule.roomType === 'AC' ? '#8ea7ff' : '#35d39a'};">
          ${escapeHtml(rule.roomType)}
        </span>
      </td>
      <td style="text-align: center; padding: 14px 12px; font-weight: 600; color: #d8e1ee;">${escapeHtml(rule.hours)} Hours</td>
      <td style="text-align: right; padding: 14px 12px; font-weight: 800; color: #72e6a8; font-size: 15px;">₹${Number(rule.price).toLocaleString()}</td>
      <td style="text-align: center; padding: 14px 12px; white-space: nowrap;">
        <button type="button" class="primary-btn" onclick="window.editPriceRule(${idx})" style="padding: 6px 14px; font-size: 11px; border-radius: 8px; margin-right: 6px; cursor: pointer;">
          ✏️ Edit
        </button>
        <button type="button" class="ghost-btn" onclick="window.deletePriceRule(${idx})" style="padding: 6px 14px; font-size: 11px; border-radius: 8px; color: #ff6b7a; border: 1px solid rgba(255,107,122,0.3); cursor: pointer;">
          🗑️ Delete
        </button>
      </td>
    </tr>
  `).join("");
}

window.editPriceRule = function (index) {
  const currentAdmin = authenticatedAdmin || sessionStorage.getItem("roomflow_admin");
  if (currentAdmin) {
    openPriceModal(index);
  } else {
    isResetFlowActive = false;
    pendingAdminAction = "editPriceRule";
    targetPriceRuleIndexForAction = index;
    openGuestLogin();
  }
};

window.deletePriceRule = function (index) {
  if (index < 0 || index >= pricingRules.length) return;
  const rule = pricingRules[index];
  showPopup("warning", "Delete Price Rule", `Are you sure you want to delete the price rule for ${rule.roomType} (${rule.hours} Hours)?`, () => {
    pricingRules.splice(index, 1);
    savePricingRules();
    renderPricingTable();
    showPopup("success", "Rule Deleted", "Price rule has been removed.");
  });
};

function openPriceModal(index = -1) {
  const overlay = $("priceRuleModalOverlay");
  if (!overlay) return;

  $("priceRuleIndex").value = index;
  if (index >= 0 && pricingRules[index]) {
    const rule = pricingRules[index];
    $("priceModalTitle").textContent = "Edit Price Rule";
    $("ruleRoomType").value = rule.roomType;
    $("ruleHours").value = rule.hours;
    $("rulePrice").value = rule.price;
  } else {
    $("priceModalTitle").textContent = "Add Price Rule";
    $("ruleRoomType").value = "AC";
    $("ruleHours").value = "";
    $("rulePrice").value = "";
  }

  overlay.classList.remove("hidden");
}

function closePriceModal() {
  const overlay = $("priceRuleModalOverlay");
  if (overlay) overlay.classList.add("hidden");
  if ($("priceRuleForm")) $("priceRuleForm").reset();
}

function updateDefaultRoomPrice() {
  const roomSelect = $("room");
  const durationInput = $("duration");
  const durationUnitSelect = $("durationUnit");
  const amountInput = $("amount");

  if (!roomSelect || !durationInput || !amountInput) return;

  const roomNumber = roomSelect.value;
  const rawDurationStr = durationInput.value ? durationInput.value.trim() : "";
  const rawDuration = parseFloat(rawDurationStr) || 0;
  const unit = durationUnitSelect ? durationUnitSelect.value : "Hour";

  if (!roomNumber || rawDurationStr === "" || rawDuration <= 0) {
    amountInput.value = "";
    calculateFinalPrice();
    return;
  }

  const totalHours = unit === "Day" ? rawDuration * 24 : rawDuration;
  const roomType = getRoomType(roomNumber);

  const matchedRule = pricingRules.find(rule => {
    if (String(rule.roomType).toLowerCase() !== String(roomType).toLowerCase()) return false;
    const range = parseHoursRange(rule.hours);
    return totalHours >= range.minHours && totalHours <= range.maxHours;
  });

  if (matchedRule) {
    amountInput.value = matchedRule.price;
  } else {
    amountInput.value = "";
  }

  calculateFinalPrice();
}

/* STAFF ATTENDANCE SYSTEM */
let currentAttendanceYear = new Date().getFullYear();
let currentAttendanceMonth = new Date().getMonth();

function initAttendanceSelectors() {
  const mSelect = $("attendanceMonthSelect");
  const ySelect = $("attendanceYearSelect");
  if (!mSelect || !ySelect) return;

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  mSelect.innerHTML = monthNames.map((m, idx) => `
    <option value="${idx}" ${idx === currentAttendanceMonth ? "selected" : ""}>${m}</option>
  `).join("");

  const startYear = 2024;
  const endYear = 2030;
  const years = [];
  for (let y = startYear; y <= endYear; y++) years.push(y);

  ySelect.innerHTML = years.map(y => `
    <option value="${y}" ${y === currentAttendanceYear ? "selected" : ""}>${y}</option>
  `).join("");

  mSelect.onchange = () => {
    currentAttendanceMonth = parseInt(mSelect.value, 10);
    renderStaffAttendanceSheet();
  };

  ySelect.onchange = () => {
    currentAttendanceYear = parseInt(ySelect.value, 10);
    renderStaffAttendanceSheet();
  };
}

function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function renderStaffAttendanceSheet() {
  const container = $("attendanceSheetContainer");
  if (!container) return;

  const daysCount = getDaysInMonth(currentAttendanceYear, currentAttendanceMonth);
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  const monthLabel = `${monthNames[currentAttendanceMonth]} ${currentAttendanceYear}`;
  if ($("statMonthLabel")) $("statMonthLabel").textContent = monthLabel;
  if ($("statMonthDays")) $("statMonthDays").textContent = daysCount;
  if ($("statTotalStaff")) $("statTotalStaff").textContent = staffList.length;

  if (staffList.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:24px; color:var(--muted);">No staff members added yet. Click "+ Add Staff Member" to add a staff member.</div>`;
    return;
  }

  let grandTotalP = 0;
  let grandTotalAbsents = 0;

  let dayHeadersHtml = "";
  for (let day = 1; day <= daysCount; day++) {
    const dObj = new Date(currentAttendanceYear, currentAttendanceMonth, day);
    const dayOfWeek = dObj.toLocaleDateString('en-US', { weekday: 'narrow' });
    dayHeadersHtml += `<th style="min-width: 32px;"><div style="font-size: 9px; color: #687990; font-weight: 500;">${dayOfWeek}</div>${day}</th>`;
  }

  const rowsHtml = staffList.map((staff) => {
    let pCount = 0;
    let aCount = 0;
    let hdCount = 0;
    let lCount = 0;
    let hcCount = 0;

    let dayCellsHtml = "";
    for (let day = 1; day <= daysCount; day++) {
      const monthStr = String(currentAttendanceMonth + 1).padStart(2, '0');
      const dayStr = String(day).padStart(2, '0');
      const dateKey = `${currentAttendanceYear}-${monthStr}-${dayStr}`;

      const rec = attendanceRecords[dateKey] || {};
      const status = rec[staff.id] || "";

      if (status === "P") pCount++;
      else if (status === "A") aCount++;
      else if (status === "HD") hdCount++;
      else if (status === "L") lCount++;
      else if (status === "HC") hcCount++;

      let badgeClass = "empty-badge";
      let badgeLabel = "-";
      if (status === "P") { badgeClass = "p-badge"; badgeLabel = "P"; }
      else if (status === "A") { badgeClass = "a-badge"; badgeLabel = "A"; }
      else if (status === "HD") { badgeClass = "hd-badge"; badgeLabel = "HD"; }
      else if (status === "L") { badgeClass = "l-badge"; badgeLabel = "L"; }
      else if (status === "HC") { badgeClass = "hc-badge"; badgeLabel = "HC"; }

      dayCellsHtml += `
        <td>
          <span class="att-badge ${badgeClass}" onclick="window.cycleAttendanceStatus('${staff.id}', '${dateKey}')" title="Day ${day} (${monthLabel}): Click to change status">
            ${badgeLabel}
          </span>
        </td>
      `;
    }

    grandTotalP += pCount;
    grandTotalAbsents += (aCount + hdCount + lCount + hcCount);

    return `
      <tr style="border-bottom: 1px solid rgba(255,255,255,0.06);">
        <td style="text-align: left; padding: 10px 12px; white-space: nowrap; position: sticky; left: 0; background: #071322; z-index: 1;">
          <div style="font-weight: 700; color: #f7fbff; font-size: 13px;">${escapeHtml(staff.name)}</div>
          <div style="font-size: 11px; color: var(--muted); display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <span>${escapeHtml(staff.role)}</span>
            ${staff.mobile ? `<span style="color:#72e6a8;">📱 ${escapeHtml(staff.mobile)}</span>` : ''}
            <button type="button" onclick="window.saveStaffAttendance('${staff.id}')" style="background:none; border:none; color:#35d39a; cursor:pointer; font-size:11px; padding:0; font-weight:600;" title="Save attendance for ${escapeHtml(staff.name)} to Google Sheets">💾 Save</button>
            <button type="button" onclick="window.editStaffMember('${staff.id}')" style="background:none; border:none; color:#8ea7ff; cursor:pointer; font-size:11px; padding:0;">✏️ Edit</button>
            <button type="button" onclick="window.deleteStaffMember('${staff.id}')" style="background:none; border:none; color:#ff6b7a; cursor:pointer; font-size:11px; padding:0;">🗑️ Delete</button>
          </div>
        </td>
        ${dayCellsHtml}
        <td style="font-weight: 700; color: #35d39a; padding: 6px 10px; background: rgba(53, 211, 154, 0.05);">${pCount}</td>
        <td style="font-weight: 700; color: #ff6b7a; padding: 6px 10px; background: rgba(255, 107, 122, 0.05);">${aCount}</td>
        <td style="font-weight: 700; color: #ffbe46; padding: 6px 10px; background: rgba(255, 190, 70, 0.05);">${hdCount}</td>
        <td style="font-weight: 700; color: #b080ff; padding: 6px 10px; background: rgba(140, 92, 255, 0.05);">${lCount}</td>
        <td style="font-weight: 700; color: #ff4d5e; padding: 6px 10px; background: rgba(230, 57, 70, 0.05);">${hcCount}</td>
      </tr>
    `;
  }).join("");

  if ($("statTotalPresents")) $("statTotalPresents").textContent = grandTotalP;
  if ($("statTotalAbsents")) $("statTotalAbsents").textContent = grandTotalAbsents;

  container.innerHTML = `
    <table class="att-table">
      <thead>
        <tr>
          <th style="text-align: left; padding-left: 12px; position: sticky; left: 0; background: #071322; z-index: 2;">Staff Member</th>
          ${dayHeadersHtml}
          <th style="color: #35d39a; background: rgba(53, 211, 154, 0.1);" title="Total Present">P</th>
          <th style="color: #ff6b7a; background: rgba(255, 107, 122, 0.1);" title="Total Absent">A</th>
          <th style="color: #ffbe46; background: rgba(255, 190, 70, 0.1);" title="Total Half Day">HD</th>
          <th style="color: #b080ff; background: rgba(140, 92, 255, 0.1);" title="Total Leave">L</th>
          <th style="color: #ff4d5e; background: rgba(230, 57, 70, 0.1);" title="Total Hotel Closed">HC</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;
}

window.cycleAttendanceStatus = function (staffId, dateKey) {
  if (!attendanceRecords[dateKey]) attendanceRecords[dateKey] = {};

  const current = attendanceRecords[dateKey][staffId] || "";
  let next = "";
  if (current === "") next = "P";
  else if (current === "P") next = "A";
  else if (current === "A") next = "HD";
  else if (current === "HD") next = "L";
  else if (current === "L") next = "HC";
  else if (current === "HC") next = "";

  attendanceRecords[dateKey][staffId] = next;
  localStorage.setItem("roomflow_attendance_records", JSON.stringify(attendanceRecords));

  const changeKey = `${staffId}_${dateKey}`;
  const syncedStatus = syncedAttendanceRecords[changeKey] || "";

  if (next !== syncedStatus) {
    pendingAttendanceChanges[changeKey] = next;
  } else {
    delete pendingAttendanceChanges[changeKey];
  }
  localStorage.setItem("roomflow_pending_attendance_changes", JSON.stringify(pendingAttendanceChanges));

  renderStaffAttendanceSheet();
};

window.saveStaffAttendance = async function (staffId) {
  const staffObj = staffList.find(s => String(s.id) === String(staffId));
  if (!staffObj) return;

  const daysCount = getDaysInMonth(currentAttendanceYear, currentAttendanceMonth);
  const recordsToSync = [];
  const staffMobile = staffObj.mobile ? String(staffObj.mobile).trim() : "";

  const loginUser = authenticatedAdmin || sessionStorage.getItem("roomflow_admin") || "";
  const loginName = loginUser ? loginUser.split("@")[0] : "Admin";
  const actionType = `Attendance marked by ${loginName}`;

  const timeFormatted = new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit"
  });

  for (let day = 1; day <= daysCount; day++) {
    const monthStr = String(currentAttendanceMonth + 1).padStart(2, '0');
    const dayStr = String(day).padStart(2, '0');
    const dateKey = `${currentAttendanceYear}-${monthStr}-${dayStr}`;

    const rec = attendanceRecords[dateKey] || {};
    const status = rec[staffObj.id] || "";

    const changeKey = `${staffObj.id}_${dateKey}`;
    const lastSyncedStatus = syncedAttendanceRecords[changeKey] || "";

    if (status && status !== lastSyncedStatus) {
      recordsToSync.push({
        syncKey: changeKey,
        action: "attendance_mark",
        actionType: "Attendance Mark",
        targetSheet: "Staff Attendance",
        staffId: staffObj.id,
        id: staffObj.id,
        staffName: staffObj.name,
        name: staffObj.name,
        role: staffObj.role || "Staff Member",
        mobile: staffMobile,
        phone: staffMobile,
        staffMobile: staffMobile,
        mobileNumber: staffMobile,
        date: dateKey,
        time: timeFormatted,
        status: status,
        details: status,
        actionType: actionType
      });
    }
  }

  if (recordsToSync.length === 0) {
    showPopup("warning", "No New Attendance to Save", `All marked attendance records for "${staffObj.name}" are already saved to the Google Sheet.`);
    return;
  }

  try {
    if (navigator.onLine) {
      for (const recPayload of recordsToSync) {
        const { syncKey, ...payloadToSend } = recPayload;
        await postWebhook(CONFIG.saveWebhookUrl, payloadToSend);
        syncedAttendanceRecords[syncKey] = recPayload.status;
        delete pendingAttendanceChanges[syncKey];
      }
      localStorage.setItem("roomflow_synced_attendance", JSON.stringify(syncedAttendanceRecords));
      localStorage.setItem("roomflow_pending_attendance_changes", JSON.stringify(pendingAttendanceChanges));

      showPopup("success", "Attendance Saved", `Newly marked attendance for "${staffObj.name}" saved to Google Sheet successfully! (${recordsToSync.length} new day(s) mapped)`);
    } else {
      recordsToSync.forEach(recPayload => {
        const { syncKey, ...payloadToSend } = recPayload;
        pendingSync.push(payloadToSend);
        syncedAttendanceRecords[syncKey] = recPayload.status;
        delete pendingAttendanceChanges[syncKey];
      });
      localStorage.setItem("roomflow_pending_sync", JSON.stringify(pendingSync));
      localStorage.setItem("roomflow_synced_attendance", JSON.stringify(syncedAttendanceRecords));
      localStorage.setItem("roomflow_pending_attendance_changes", JSON.stringify(pendingAttendanceChanges));
      showPopup("success", "Saved Locally", `Attendance for "${staffObj.name}" saved locally (${recordsToSync.length} new day(s)). Will auto-sync when internet connects.`);
    }
  } catch (err) {
    recordsToSync.forEach(recPayload => {
      const { syncKey, ...payloadToSend } = recPayload;
      pendingSync.push(payloadToSend);
      syncedAttendanceRecords[syncKey] = recPayload.status;
      delete pendingAttendanceChanges[syncKey];
    });
    localStorage.setItem("roomflow_pending_sync", JSON.stringify(pendingSync));
    localStorage.setItem("roomflow_synced_attendance", JSON.stringify(syncedAttendanceRecords));
    localStorage.setItem("roomflow_pending_attendance_changes", JSON.stringify(pendingAttendanceChanges));
    showPopup("success", "Saved Locally", `Attendance for "${staffObj.name}" saved locally (${recordsToSync.length} new day(s)). Will auto-sync when internet connects.`);
  }
};

window.editStaffMember = function (staffId) {
  const staff = staffList.find(s => String(s.id) === String(staffId));
  if (!staff) return;
  const currentAdmin = authenticatedAdmin || sessionStorage.getItem("roomflow_admin");
  if (currentAdmin) {
    openStaffModal(staff);
  } else {
    isResetFlowActive = false;
    pendingAdminAction = "editStaff";
    targetStaffIdForAction = staffId;
    openGuestLogin();
  }
};

window.deleteStaffMember = function (staffId) {
  const staff = staffList.find(s => String(s.id) === String(staffId));
  if (!staff) return;

  showPopup(
    "warning",
    "Delete Staff Member",
    `Are you sure you want to delete staff member "${staff.name}" (${staff.role})?\n\nThis will remove them from your active staff list.`,
    () => {
      staffList = staffList.filter(s => String(s.id) !== String(staffId));
      localStorage.setItem("roomflow_staff_list", JSON.stringify(staffList));

      const staffMobile = staff.mobile ? String(staff.mobile).trim() : "";
      const payload = {
        action: "staff_delete",
        targetSheet: "Staff Attendance",
        staffId: staff.id,
        staffName: staff.name,
        name: staff.name,
        role: staff.role,
        mobile: staffMobile,
        phone: staffMobile,
        staffMobile: staffMobile
      };

      if (navigator.onLine) {
        postWebhook(CONFIG.saveWebhookUrl, payload).catch(() => {
          pendingSync.push(payload);
          localStorage.setItem("roomflow_pending_sync", JSON.stringify(pendingSync));
        });
      } else {
        pendingSync.push(payload);
        localStorage.setItem("roomflow_pending_sync", JSON.stringify(pendingSync));
      }

      renderStaffAttendanceSheet();
      closeStaffModal();
      showPopup("success", "Staff Member Deleted", `Staff member "${staff.name}" removed successfully.`);
    }
  );
};

function openStaffModal(staffObj = null) {
  const overlay = $("staffModalOverlay");
  if (!overlay) return;

  const deleteBtn = $("deleteStaffModalBtn");

  if (staffObj) {
    $("staffModalTitle").textContent = "Edit Staff Member";
    $("staffIdInput").value = staffObj.id;
    $("staffNameInput").value = staffObj.name;
    $("staffRoleInput").value = staffObj.role;
    $("staffMobileInput").value = staffObj.mobile || "";

    if (deleteBtn) {
      deleteBtn.classList.remove("hidden");
      deleteBtn.onclick = () => window.deleteStaffMember(staffObj.id);
    }
  } else {
    $("staffModalTitle").textContent = "Add Staff Member";
    $("staffIdInput").value = "";
    $("staffNameInput").value = "";
    $("staffRoleInput").value = "Housekeeping";
    $("staffMobileInput").value = "";

    if (deleteBtn) deleteBtn.classList.add("hidden");
  }

  overlay.classList.remove("hidden");
}

function closeStaffModal() {
  const overlay = $("staffModalOverlay");
  if (overlay) overlay.classList.add("hidden");
  if ($("staffForm")) $("staffForm").reset();
}

/* FORM HANDLERS & EVENT BINDINGS */
function handleLogin(event) {
  if (event) event.preventDefault();
  const emailEl = $("loginEmail");
  const passEl = $("loginPassword");
  const msgEl = $("loginMsg");
  const inputVal = emailEl ? emailEl.value.trim() : "";
  const password = passEl ? passEl.value : "";
  const inputLower = inputVal.toLowerCase();

  const isDemo = (inputLower === CONFIG.demoEmail.toLowerCase() && password === CONFIG.demoPassword);

  let matchedAdmin = null;
  for (const [adminUser, adminPass] of Object.entries(CONFIG.admins)) {
    if (adminUser.toLowerCase() === inputLower && password === adminPass) {
      matchedAdmin = adminUser;
      break;
    }
  }

  if (isDemo || matchedAdmin) {
    const rememberCheckbox = $("rememberPassword");
    if (rememberCheckbox && rememberCheckbox.checked) {
      localStorage.setItem("roomflow_remember_login", "1");
      localStorage.setItem("roomflow_saved_email", inputVal);
      localStorage.setItem("roomflow_saved_password", password);
    } else {
      localStorage.removeItem("roomflow_remember_login");
      localStorage.removeItem("roomflow_saved_email");
      localStorage.removeItem("roomflow_saved_password");
    }

    sessionStorage.setItem("roomflow_logged_in", "1");
    if (matchedAdmin) {
      authenticatedAdmin = matchedAdmin;
      sessionStorage.setItem("roomflow_admin", matchedAdmin);
    } else {
      authenticatedAdmin = null;
      sessionStorage.removeItem("roomflow_admin");
    }
    if (msgEl) msgEl.textContent = "";
    showApp();
  } else {
    if (msgEl) {
      msgEl.textContent = "Incorrect email/username or password.";
      msgEl.style.color = "#ff6b7a";
    }
  }
}

function handleGuestLogin(event) {
  if (event) event.preventDefault();
  const username = $("guestUsername") ? $("guestUsername").value.trim() : "";
  const password = $("guestPassword") ? $("guestPassword").value : "";
  const msgEl = $("guestLoginMsg");

  if (authenticateAdmin(username, password)) {
    sessionStorage.setItem("roomflowGuestAuthenticated", "true");
    sessionStorage.setItem("roomflowGuestUser", username);

    if (msgEl) {
      msgEl.textContent = "Login successful.";
      msgEl.style.color = "#72e6a8";
    }

    setTimeout(() => {
      const actionToExecute = pendingAdminAction;
      const targetStaffId = targetStaffIdForAction;
      const targetPriceRuleIdx = targetPriceRuleIndexForAction;

      closeGuestLogin();

      if (isResetFlowActive) {
        isResetFlowActive = false;
        executeMasterReset(username);
      } else if (actionToExecute === "addStaff") {
        openStaffModal(null);
      } else if (actionToExecute === "addPriceRule") {
        openPriceModal(-1);
      } else if (actionToExecute === "editStaff") {
        const staffObj = staffList.find(s => String(s.id) === String(targetStaffId));
        if (staffObj) openStaffModal(staffObj);
      } else if (actionToExecute === "editPriceRule") {
        if (targetPriceRuleIdx !== null && targetPriceRuleIdx >= 0) openPriceModal(targetPriceRuleIdx);
      } else {
        navigate("guestList");
      }
    }, 350);
  } else {
    if (msgEl) {
      msgEl.textContent = "Invalid username or password.";
      msgEl.style.color = "#ff6b7a";
    }
    if ($("guestPassword")) {
      $("guestPassword").value = "";
      $("guestPassword").focus();
    }
  }
}

function logout() {
  sessionStorage.removeItem("roomflow_logged_in");
  sessionStorage.removeItem("roomflow_admin");
  authenticatedAdmin = null;
  showLogin();
}

function handleForgotPassword(event) {
  if (event) event.preventDefault();
  const modal = $("modal");
  if (modal) modal.classList.remove("hidden");
}

async function handleClientSubmit(event) {
  if (event) event.preventDefault();

  if (!validateClientForm()) return;

  const room = $("room").value;
  const roomDisplayName = getRoomDisplayName(room);
  const includeFreeHall = $("includeFreeHall") ? $("includeFreeHall").checked : false;

  if (clients.some(client => String(client.room) === String(room) && client.status === "Occupied")) {
    $("room").classList.add("invalid");
    showPopup("error", "Room Already Occupied", `${roomDisplayName} is already occupied. Please select another room.`);
    $("room").focus();
    return;
  }

  if (includeFreeHall && String(room) !== "Hall") {
    const isHallBusy = clients.some(client => client.status === "Occupied" && (String(client.room) === "Hall" || client.includeFreeHall));
    if (isHallBusy) {
      showPopup("error", "Hall Already Occupied / Reserved", "The Celebration Hall is currently occupied or reserved for another guest stay. Please uncheck the free hall option or choose another date/time.");
      return;
    }
  }

  const duration = $("duration") ? Number($("duration").value) : 1;
  const durationUnit = $("durationUnit") ? $("durationUnit").value : "Hour";
  const amount = Number($("amount").value) || 0;
  const discount = $("discount") ? Number($("discount").value) || 0 : 0;
  const additionalCharges = $("additionalCharges") ? Number($("additionalCharges").value) || 0 : 0;
  const finalPrice = Math.max(0, amount + additionalCharges - discount);
  const roomType = getRoomType(room);

  const now = new Date();
  const checkinDateTime = now.toISOString();
  const checkinDateFormatted = now.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  const checkinTimeFormatted = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });

  const clientId = "RF_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
  const formattedRoom = String(room).toLowerCase().includes("hall") ? roomDisplayName : `${room} (${roomType})`;

  const payload = {
    action: "client_add",
    targetSheet: "Clients",
    id: clientId,

    "Sr No": clients.length + 1,
    "His Name 👦🏻": $("hisName") ? $("hisName").value.trim() : "",
    "His Mobile": $("hisMobile") ? $("hisMobile").value.trim() : "",
    "His Aadhaar Card Number": $("hisAadhar") ? $("hisAadhar").value.trim() : "",
    "Her Name 👧🏻": $("herName") ? $("herName").value.trim() : "",
    "Her Mobile": $("herMobile") ? $("herMobile").value.trim() : "",
    "Her Aadhaar Card Number": $("herAadhar") ? $("herAadhar").value.trim() : "",
    "Amount": finalPrice,
    "Mode of Payment": $("paymentMode") ? $("paymentMode").value : "",
    "Check-In-Date": checkinDateFormatted,
    "Check-In-Time": checkinTimeFormatted,
    "Alloted Room Number": formattedRoom,
    "Time Duration": duration,
    "Hour / Day": durationUnit,
    "Check-Out-Date": "-",
    "Check-Out-Time": "-",

    srNo: clients.length + 1,
    hisName: $("hisName") ? $("hisName").value.trim() : "",
    hisMobile: $("hisMobile") ? $("hisMobile").value.trim() : "",
    hisAadhar: $("hisAadhar") ? $("hisAadhar").value.trim() : "",
    hisAadhaar: $("hisAadhar") ? $("hisAadhar").value.trim() : "",
    herName: $("herName") ? $("herName").value.trim() : "",
    herMobile: $("herMobile") ? $("herMobile").value.trim() : "",
    herAadhar: $("herAadhar") ? $("herAadhar").value.trim() : "",
    herAadhaar: $("herAadhar") ? $("herAadhar").value.trim() : "",
    amount: amount,
    additionalCharges: additionalCharges,
    finalPrice: finalPrice,
    paymentMode: $("paymentMode") ? $("paymentMode").value : "",
    checkinDate: checkinDateFormatted,
    checkinDateFormatted: checkinDateFormatted,
    checkinTime: checkinTimeFormatted,
    checkinTimeFormatted: checkinTimeFormatted,
    allotedRoomNumber: formattedRoom,
    allottedRoom: formattedRoom,
    room: room,
    roomDisplayName: roomDisplayName,
    roomType: roomType,
    duration: duration,
    durationUnit: durationUnit,
    checkoutDate: "-",
    checkoutDateFormatted: "-",
    checkoutTime: "-",
    checkoutTimeFormatted: "-",
    date: $("date") ? $("date").value : today,
    discount: discount,
    checkinDateTime: checkinDateTime,
    checkoutDateTime: null,
    status: "Occupied",
    includeFreeHall: includeFreeHall
  };

  const saveButton = $("saveClientBtn");
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.innerHTML = "Saving...";
  }

  try {
    clients.push(payload);
    clients = deduplicateClients(clients);
    localStorage.setItem("roomflow_clients", JSON.stringify(clients));

    if (navigator.onLine) {
      await postWebhook(CONFIG.saveWebhookUrl, payload);
    } else {
      pendingSync.push(payload);
      localStorage.setItem("roomflow_pending_sync", JSON.stringify(pendingSync));
    }

    if (event.target && event.target.reset) event.target.reset();
    if ($("date")) $("date").value = today;

    render();
    startCountdownTimer();

    const freeHallText = includeFreeHall ? "\n🎉 Complimentary Birthday Hall Reserved" : "";
    showPopup(
      "success",
      "Client Saved Successfully",
      `The client has been successfully checked in.\n\nAllotted Room: ${roomDisplayName}\nRoom Type: ${roomType}${freeHallText}\nCheck-in Date & Time: ${checkinDateFormatted}, ${checkinTimeFormatted}\nDuration: ${duration} ${durationUnit}`
    );
  } catch (error) {
    pendingSync.push(payload);
    localStorage.setItem("roomflow_pending_sync", JSON.stringify(pendingSync));

    if (event.target && event.target.reset) event.target.reset();
    if ($("date")) $("date").value = today;

    render();
    startCountdownTimer();

    showPopup(
      "success",
      "Client Saved Locally",
      `Client checked in locally.\n\nAllotted Room: ${roomDisplayName}\nRoom Type: ${roomType}\nData will auto-sync once internet connection stabilizes.`
    );
  } finally {
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.innerHTML = "Save Client <span>→</span>";
    }
  }
}

function handleStaffFormSubmit(event) {
  if (event) event.preventDefault();
  const sId = $("staffIdInput") ? $("staffIdInput").value : "";
  const name = $("staffNameInput") ? $("staffNameInput").value.trim() : "";
  const role = $("staffRoleInput") ? $("staffRoleInput").value.trim() || "Staff Member" : "Staff Member";
  const mobile = $("staffMobileInput") ? $("staffMobileInput").value.trim() : "";

  if (!name) {
    showPopup("error", "Validation Error", "Please enter staff name.");
    return;
  }

  let targetStaff;
  if (sId) {
    const idx = staffList.findIndex(s => String(s.id) === String(sId));
    if (idx >= 0) {
      staffList[idx].name = name;
      staffList[idx].role = role;
      staffList[idx].mobile = mobile;
      targetStaff = staffList[idx];
    }
  } else {
    targetStaff = {
      id: "STF_" + Date.now(),
      name: name,
      role: role,
      mobile: mobile
    };
    staffList.push(targetStaff);
  }

  localStorage.setItem("roomflow_staff_list", JSON.stringify(staffList));

  if (targetStaff) {
    const staffMobile = targetStaff.mobile ? String(targetStaff.mobile).trim() : "";
    const payload = {
      action: "staff_add",
      targetSheet: "Staff Attendance",
      staffId: targetStaff.id,
      staffName: targetStaff.name,
      name: targetStaff.name,
      role: targetStaff.role,
      mobile: staffMobile,
      phone: staffMobile,
      staffMobile: staffMobile,
      mobileNumber: staffMobile
    };

    if (navigator.onLine) {
      postWebhook(CONFIG.saveWebhookUrl, payload).catch(() => {
        pendingSync.push(payload);
        localStorage.setItem("roomflow_pending_sync", JSON.stringify(pendingSync));
      });
    } else {
      pendingSync.push(payload);
      localStorage.setItem("roomflow_pending_sync", JSON.stringify(pendingSync));
    }
  }

  renderStaffAttendanceSheet();
  closeStaffModal();
  showPopup("success", "Staff Saved", `Staff member "${name}" saved successfully.`);
}

function openStaffModal(staffObj = null) {
  const overlay = $("staffModalOverlay");
  if (!overlay) return;

  const deleteBtn = $("deleteStaffModalBtn");

  if (staffObj) {
    $("staffModalTitle").textContent = "Edit Staff Member";
    $("staffIdInput").value = staffObj.id;
    $("staffNameInput").value = staffObj.name;
    $("staffRoleInput").value = staffObj.role;
    $("staffMobileInput").value = staffObj.mobile || "";

    if (deleteBtn) {
      deleteBtn.classList.remove("hidden");
      deleteBtn.onclick = () => window.deleteStaffMember(staffObj.id);
    }
  } else {
    $("staffModalTitle").textContent = "Add Staff Member";
    $("staffIdInput").value = "";
    $("staffNameInput").value = "";
    $("staffRoleInput").value = "Housekeeping";
    $("staffMobileInput").value = "";

    if (deleteBtn) deleteBtn.classList.add("hidden");
  }

  overlay.classList.remove("hidden");
}

function closeStaffModal() {
  const overlay = $("staffModalOverlay");
  if (overlay) overlay.classList.add("hidden");
  if ($("staffForm")) $("staffForm").reset();
}



function bindAllEvents() {
  document.querySelectorAll(".nav-item").forEach(button => {
    button.onclick = () => navigate(button.dataset.section);
  });

  if ($("quickAdd")) $("quickAdd").onclick = () => navigate("clients");
  if ($("backDashboardFromGuest")) $("backDashboardFromGuest").onclick = () => navigate("dashboard");
  if ($("printGuestListBtn")) $("printGuestListBtn").onclick = () => window.print();

  if ($("guestListBtn")) {
    $("guestListBtn").onclick = (e) => {
      e.preventDefault();
      isResetFlowActive = false;
      const currentAdmin = authenticatedAdmin || sessionStorage.getItem("roomflow_admin");
      if (currentAdmin) navigate("guestList");
      else openGuestLogin();
    };
  }

  if ($("masterResetBtn")) $("masterResetBtn").onclick = masterResetDashboard;
  if ($("logoutBtn")) $("logoutBtn").onclick = logout;
  if ($("forgotBtn")) $("forgotBtn").onclick = handleForgotPassword;
  if ($("closeModal")) {
    $("closeModal").onclick = () => {
      const modal = $("modal");
      if (modal) modal.classList.add("hidden");
    };
  }

  if ($("togglePassword")) {
    $("togglePassword").onclick = () => {
      const password = $("loginPassword");
      if (password) password.type = password.type === "password" ? "text" : "password";
    };
  }

  if ($("guestTogglePassword")) {
    $("guestTogglePassword").onclick = () => {
      const password = $("guestPassword");
      if (password) password.type = password.type === "password" ? "text" : "password";
    };
  }

  if ($("guestLoginCancel")) $("guestLoginCancel").onclick = closeGuestLogin;
  if ($("guestLoginClose")) $("guestLoginClose").onclick = closeGuestLogin;

  if ($("loginForm")) $("loginForm").onsubmit = handleLogin;
  if ($("guestLoginForm")) $("guestLoginForm").onsubmit = handleGuestLogin;
  if ($("clientForm")) $("clientForm").onsubmit = handleClientSubmit;
  if ($("staffForm")) $("staffForm").onsubmit = handleStaffFormSubmit;

  if ($("priceRuleForm")) {
    $("priceRuleForm").onsubmit = event => {
      event.preventDefault();
      const idx = parseInt($("priceRuleIndex").value, 10);
      const roomType = $("ruleRoomType").value;
      const hours = $("ruleHours").value.trim();
      const price = parseFloat($("rulePrice").value) || 0;

      const ruleData = { id: idx >= 0 ? pricingRules[idx].id : Date.now(), roomType, hours, price };

      if (idx >= 0) pricingRules[idx] = ruleData;
      else pricingRules.push(ruleData);

      savePricingRules();
      renderPricingTable();
      closePriceModal();
      showPopup("success", "Price Rule Saved", `Price for ${roomType} (${hours} Hours) saved as ₹${price}.`);
    };
  }

  if ($("popupOkBtn")) {
    $("popupOkBtn").onclick = () => {
      const callback = confirmCallback;
      confirmCallback = null;
      closePopup();
      if (callback) callback();
    };
  }

  if ($("popupCancelBtn")) {
    $("popupCancelBtn").onclick = () => {
      confirmCallback = null;
      closePopup();
    };
  }

  if ($("closeGuestDetailsModal")) {
    $("closeGuestDetailsModal").onclick = () => {
      if ($("guestDetailsModal")) $("guestDetailsModal").classList.add("hidden");
    };
  }

  if ($("okGuestDetailsModal")) {
    $("okGuestDetailsModal").onclick = () => {
      if ($("guestDetailsModal")) $("guestDetailsModal").classList.add("hidden");
    };
  }

  if ($("amount")) {
    $("amount").oninput = calculateFinalPrice;
    $("amount").onkeyup = calculateFinalPrice;
  }

  if ($("additionalCharges")) {
    $("additionalCharges").oninput = calculateFinalPrice;
    $("additionalCharges").onkeyup = calculateFinalPrice;
  }

  if ($("discount")) {
    $("discount").oninput = calculateFinalPrice;
    $("discount").onkeyup = calculateFinalPrice;
  }

  if ($("room")) {
    $("room").onchange = () => {
      updateDefaultRoomPrice();
      toggleFreeHallCheckbox();
    };
  }
  if ($("duration")) {
    $("duration").oninput = updateDefaultRoomPrice;
    $("duration").onkeyup = updateDefaultRoomPrice;
    $("duration").onchange = updateDefaultRoomPrice;
  }
  if ($("durationUnit")) {
    $("durationUnit").onchange = updateDefaultRoomPrice;
  }

  if ($("addPriceRuleBtn")) {
    $("addPriceRuleBtn").onclick = () => {
      isResetFlowActive = false;
      const currentAdmin = authenticatedAdmin || sessionStorage.getItem("roomflow_admin");
      if (currentAdmin) {
        openPriceModal(-1);
      } else {
        pendingAdminAction = "addPriceRule";
        openGuestLogin();
      }
    };
  }
  if ($("closePriceModalBtn")) $("closePriceModalBtn").onclick = closePriceModal;

  if ($("addStaffBtn")) {
    $("addStaffBtn").onclick = () => {
      isResetFlowActive = false;
      const currentAdmin = authenticatedAdmin || sessionStorage.getItem("roomflow_admin");
      if (currentAdmin) {
        openStaffModal(null);
      } else {
        pendingAdminAction = "addStaff";
        openGuestLogin();
      }
    };
  }
  if ($("closeStaffModalBtn")) $("closeStaffModalBtn").onclick = closeStaffModal;
}

function toggleFreeHallCheckbox() {
  const roomSelect = $("room");
  const container = $("freeHallContainer");
  const checkbox = $("includeFreeHall");
  const note = $("freeHallNote");

  if (!roomSelect || !container || !checkbox) return;

  const selectedRoom = roomSelect.value;

  if (!selectedRoom || String(selectedRoom) === "Hall") {
    container.classList.add("hidden");
    checkbox.checked = false;
    return;
  }

  container.classList.remove("hidden");

  const isHallBusy = clients.some(client =>
    client.status === "Occupied" && (String(client.room) === "Hall" || client.includeFreeHall)
  );

  if (isHallBusy) {
    checkbox.disabled = true;
    checkbox.checked = false;
    if (note) {
      note.textContent = "⚠️ Celebration Hall is currently occupied or reserved by another guest.";
      note.style.color = "#ff6b7a";
    }
  } else {
    checkbox.disabled = false;
    if (note) {
      note.textContent = "Checking this reserves the Hall for this guest during their stay so other guests know the Hall is unavailable.";
      note.style.color = "#91a2b7";
    }
  }
}

/* Initialization */
loadRememberedLogin();

document.addEventListener("DOMContentLoaded", () => {
  bindAllEvents();
  if (sessionStorage.getItem("roomflow_logged_in") === "1") {
    showApp();
  } else {
    showLogin();
    render();
  }
});
