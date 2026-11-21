const byId = id => document.getElementById(id);
const fileInput = byId("file");
const dropZone = byId("drop-zone");
const fileStatus = byId("file-status");
const progress = byId("progress");
const results = byId("results");
const clearButton = byId("clear");
const copyButton = byId("copy");
const command = byId("command");
const copyStatus = byId("copy-status");
const selected = new Set();
const teams = [];
let currentWorker;

function renderSelection() {
  for (const team of teams) {
    const all = team.players.every(player => selected.has(player.slot));
    for (const player of team.players) player.input.checked = selected.has(player.slot);
    team.button.textContent = all ? "Clear team" : "Select team";
    team.button.setAttribute("aria-label", team.button.textContent + " " + team.label);
  }

  command.value = selected.size ? voiceCommand(selected) : "";
  copyButton.disabled = clearButton.disabled = selected.size === 0;
  copyStatus.textContent = "";
}

function createElement(tag, className, label) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (label) element.textContent = label;
  return element;
}

function makeTeam(label, side, players, hasVoice) {
  const section = createElement("section", "team team-" + side);
  const heading = createElement("h3", "", label);
  heading.id = "team-heading-" + side;
  section.setAttribute("aria-labelledby", heading.id);
  const header = createElement("div", "team-head");
  const button = createElement("button", "", "Select team");
  button.type = "button";
  button.disabled = !hasVoice;
  header.append(heading, button);

  const list = createElement("ul", "players");
  const rows = [];
  for (const player of players) {
    const item = createElement("li");
    const row = createElement("label", "player");
    const input = createElement("input");
    input.type = "checkbox";
    input.disabled = !hasVoice;
    input.addEventListener("change", () => {
      if (input.checked) selected.add(player.slot);
      else selected.delete(player.slot);
      renderSelection();
    });
    const name = createElement("span", "player-name", player.name);
    const details = "Spec " + (player.slot + 1) + (hasVoice && !player.spoke ? " · No voice" : "");
    const meta = createElement("span", "player-meta", details);
    row.append(input, name, meta);
    item.append(row);
    list.append(item);
    rows.push({ slot: player.slot, input });
  }

  button.addEventListener("click", () => {
    const all = rows.every(player => selected.has(player.slot));
    for (const player of rows) {
      if (all) selected.delete(player.slot);
      else selected.add(player.slot);
    }
    renderSelection();
  });
  teams.push({ label, button, players: rows });
  section.append(header, list);
  return section;
}

function showRoster(data, fileName) {
  fileStatus.textContent = fileName;
  byId("match-heading").textContent = data.map || "Match roster";
  const count = data.players.length;
  byId("match-detail").textContent = count + (count === 1 ? " player" : " players") + " · Team sides near the end of the demo";
  const notes = [];
  if (!data.voicePackets) notes.push("No recorded voice chat found in this demo.");
  if (data.players.some(player => player.side === 0)) notes.push("Players with an unknown team can still be selected by slot.");
  if (data.players.some(player => player.slotReused)) notes.push("Some slots were reused. CS2 plays every voice recorded in a selected slot.");
  byId("roster-note").textContent = notes.join(" ");
  byId("roster-note").hidden = !notes.length;

  const groups = [[3, "Counter-Terrorists"], [2, "Terrorists"], [0, "Team unknown"]];
  byId("teams").replaceChildren();
  for (const [side, label] of groups) {
    const players = data.players.filter(player => player.side === side);
    if (players.length) byId("teams").append(makeTeam(label, side, players, data.voicePackets > 0));
  }
  results.hidden = false;
  renderSelection();
}

function showError(message) {
  fileStatus.textContent = message;
  fileStatus.classList.add("error");
  progress.hidden = true;
}

function loadDemo(file) {
  if (currentWorker) currentWorker.terminate();
  currentWorker = null;
  teams.length = 0;
  selected.clear();
  results.hidden = true;
  fileStatus.classList.remove("error");
  fileStatus.textContent = "Reading " + file.name + "…";
  progress.value = 0;
  progress.hidden = false;

  const workerCode = byId("demo-reader").textContent + "\n" +
    "self.onmessage = async ({ data }) => {\n" +
    "  try {\n" +
    "    const result = await parseDemo(data, progress => self.postMessage({ progress }));\n" +
    "    self.postMessage({ result });\n" +
    "  } catch (err) { self.postMessage({ error: err.message || String(err) }); }\n" +
    "};";
  const url = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
  try {
    const worker = new Worker(url);
    currentWorker = worker;
    worker.onmessage = ({ data }) => {
      if (currentWorker !== worker) return;
      if (typeof data.progress === "number") {
        progress.value = data.progress * 100;
        return;
      }
      worker.terminate();
      currentWorker = null;
      progress.hidden = true;
      if (data.error) showError(data.error);
      else showRoster(data.result, file.name);
    };
    worker.onerror = () => {
      if (currentWorker !== worker) return;
      worker.terminate();
      currentWorker = null;
      showError("The browser could not start the demo reader. Try opening this file in a current browser.");
    };
    worker.postMessage(file);
  } catch {
    showError("The browser could not start the demo reader. Try opening this file in a current browser.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

byId("choose").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  fileInput.value = "";
  if (file) loadDemo(file);
});

window.addEventListener("dragover", event => {
  if (!Array.from(event.dataTransfer.types).includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  dropZone.classList.add("active");
});

window.addEventListener("dragleave", event => {
  if (!event.relatedTarget) dropZone.classList.remove("active");
});

window.addEventListener("drop", event => {
  event.preventDefault();
  dropZone.classList.remove("active");
  if (event.dataTransfer.files.length === 1) loadDemo(event.dataTransfer.files[0]);
  else if (event.dataTransfer.files.length > 1 && !currentWorker) showError("Open one demo at a time.");
});

clearButton.addEventListener("click", () => {
  selected.clear();
  renderSelection();
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(command.value);
    copyStatus.textContent = "Copied.";
  } catch {
    command.select();
    copyStatus.textContent = document.execCommand("copy") ? "Copied." : "Press Ctrl+C or ⌘C to copy the selected command.";
  }
});
