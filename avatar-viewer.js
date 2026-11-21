const fs = require("fs");
const vm = require("vm");

const file = "public/index.html";
let html = fs.readFileSync(file, "utf8");

const old = '$("profileAvatar").addEventListener("click", () => avatarInput.click());';

const replacement = [
'function openAvatarViewer() {',
'  if (!currentUser?.profile_picture) { avatarInput.click(); return; }',
'  const overlay = document.createElement("div");',
'  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.94);z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;";',
'  const close = document.createElement("button");',
'  close.textContent = "✕";',
'  close.style.cssText = "position:absolute;top:25px;right:20px;background:#333;color:white;border:0;border-radius:50%;width:44px;height:44px;font-size:22px;";',
'  const img = document.createElement("img");',
'  img.src = currentUser.profile_picture;',
'  img.style.cssText = "max-width:100%;max-height:75vh;object-fit:contain;border-radius:12px;";',
'  const remove = document.createElement("button");',
'  remove.textContent = "Remove profile photo";',
'  remove.style.cssText = "margin-top:25px;padding:14px 24px;background:#d93030;color:white;border:0;border-radius:25px;font-weight:700;font-size:15px;";',
'  close.onclick = () => overlay.remove();',
'  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };',
'  img.onclick = e => e.stopPropagation();',
'  remove.onclick = async () => {',
'    if (!confirm("Remove your profile photo?")) return;',
'    remove.disabled = true;',
'    try {',
'      await api("/api/profile/avatar", { method: "DELETE" });',
'      currentUser.profile_picture = null;',
'      overlay.remove();',
'      updateProfile();',
'      toast("Profile photo removed");',
'      buzz(20);',
'    } catch(e) {',
'      remove.disabled = false;',
'      toast(e.message || "Could not remove photo");',
'    }',
'  };',
'  overlay.append(close, img, remove);',
'  document.body.appendChild(overlay);',
'}',
'',
'$("profileAvatar").addEventListener("click", openAvatarViewer);'
].join("\n");

if (html.split(old).length !== 2) {
  throw Error("Could not find the exact avatar click handler. No changes made.");
}

html = html.replace(old, replacement);

const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(m => m[1]).filter(s => s.trim());

scripts.forEach((s, i) => new vm.Script(s, {filename:"script-"+i+".js"}));

fs.mkdirSync("backups", {recursive:true});
const backup = "backups/index-before-viewer-" + Date.now() + ".html";
fs.copyFileSync(file, backup);
const temp = file + ".tmp";
fs.writeFileSync(temp, html);
fs.renameSync(temp, file);

console.log("SUCCESS: Full-screen photo viewer and removal installed.");
console.log("Backup: " + backup);
console.log("JavaScript validation passed.");
