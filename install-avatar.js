const fs = require("fs");
const vm = require("vm");

const file = "public/index.html";
const html = fs.readFileSync(file, "utf8");
let updated = html;

function replaceOnce(oldText, newText, label) {
  const count = updated.split(oldText).length - 1;
  if (count !== 1) throw Error(label + ": expected one match, found " + count);
  updated = updated.replace(oldText, newText);
}

// 1. Avatar styling
replaceOnce(
`.profile-avatar {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: var(--blue);
  display: grid;
  place-items: center;
  color: white;
  font-size: 25px;
}`,
`.profile-avatar {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: var(--blue);
  display: grid;
  place-items: center;
  color: white;
  font-size: 25px;
  overflow: hidden;
  flex-shrink: 0;
  cursor: pointer;
}
.profile-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}`,
"profile CSS"
);

// 2. Add hidden gallery input
replaceOnce(
`<div class="profile-avatar" id="profileAvatar">S</div>`,
`<div class="profile-avatar" id="profileAvatar" title="Change profile photo">S</div>
      <input id="avatarInput" type="file" accept="image/jpeg,image/png,image/webp" hidden>`,
"profile HTML"
);

// 3. Update profile display
replaceOnce(
`function updateProfile() {
  const name = currentUser?.name || currentUser?.username || "STUMZY User";
  const email = currentUser?.email || "";

  $("profileName").textContent = currentUser?.display_name || name;
  $("profileEmail").textContent = email;
  $("profileAvatar").textContent = name.charAt(0).toUpperCase();
}`,
`function updateProfile() {
  const name = currentUser?.name || currentUser?.username || "STUMZY User";
  const email = currentUser?.email || "";

  $("profileName").textContent = currentUser?.display_name || name;
  $("profileEmail").textContent = email;

  const avatar = $("profileAvatar");
  avatar.replaceChildren();

  if (currentUser?.profile_picture) {
    const img = document.createElement("img");
    img.src = currentUser.profile_picture;
    img.alt = "Profile photo";
    avatar.appendChild(img);
  } else {
    avatar.textContent = name.charAt(0).toUpperCase();
  }
}

// PROFILE PHOTO UPLOAD
const avatarInput = $("avatarInput");

$("profileAvatar").addEventListener("click", () => avatarInput.click());

avatarInput.addEventListener("change", async function() {
  const file = this.files && this.files[0];
  if (!file) return;

  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    toast("Choose a JPG, PNG or WebP image");
    this.value = "";
    return;
  }

  if (file.size > 2 * 1024 * 1024) {
    toast("Image must be under 2 MB");
    this.value = "";
    return;
  }

  const reader = new FileReader();

  reader.onload = async () => {
    try {
      const result = await api("/api/profile/avatar", {
        method: "POST",
        body: JSON.stringify({ image: reader.result })
      });

      currentUser.profile_picture = result.profile_picture;
      updateProfile();
      toast("Profile photo updated!");
      buzz(20);
    } catch(e) {
      toast(e.message || "Upload failed");
    }
  };

  reader.onerror = () => toast("Could not read image");

  reader.readAsDataURL(file);
  this.value = "";
});`,
"profile updater and upload handler"
);

// 4. Validate every inline script before touching the live file
const scripts = [...updated.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(x => x[1])
  .filter(x => x.trim());

if (!scripts.length) throw Error("No JavaScript found");

scripts.forEach((script, i) => new vm.Script(script, { filename: "inline-" + (i + 1) + ".js" }));

// 5. Backup, then replace atomically
const stat = fs.statSync(file);
const backup = "backups/index-before-avatar-" + Date.now() + ".html";
fs.mkdirSync("backups", { recursive: true });
fs.copyFileSync(file, backup);

const temp = file + ".tmp";
fs.writeFileSync(temp, updated, { mode: stat.mode });
fs.chmodSync(temp, stat.mode);
fs.renameSync(temp, file);

console.log("SUCCESS: Profile photo feature installed.");
console.log("Backup: " + backup);
console.log("JavaScript validation: passed");
