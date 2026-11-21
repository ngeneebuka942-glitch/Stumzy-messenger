const fs = require("fs");
const cp = require("child_process");

const file = "public/index.html";
let html = fs.readFileSync(file, "utf8");

function replaceOnce(oldText, newText, label) {
  const index = html.indexOf(oldText);
  if (index === -1 || html.indexOf(oldText, index + 1) !== -1) {
    throw Error("Cannot safely locate " + label);
  }
  html = html.slice(0, index) + newText + html.slice(index + oldText.length);
}

replaceOnce(
`.profile-avatar {
  width: 60px;`,
`.profile-avatar {
  cursor: pointer;
  overflow: hidden;
  width: 60px;`,
"avatar CSS"
);

replaceOnce(
`.profile-avatar {
  cursor: pointer;
  overflow: hidden;
  width: 60px;`,
`.profile-avatar {
  cursor: pointer;
  overflow: hidden;
  width: 60px;`,
"avatar CSS validation"
);

// Add image styling
replaceOnce(
`.profile-name {
  font-size: 17px;`,
`.profile-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}

.profile-name {
  font-size: 17px;`,
"avatar image CSS"
);

// Add upload control
replaceOnce(
`<div class="profile-avatar" id="profileAvatar">S</div>`,
`<div class="profile-avatar" id="profileAvatar" onclick="$('avatarInput').click()" title="Change profile photo">S</div>
      <input id="avatarInput" type="file" accept="image/jpeg,image/png,image/webp" hidden>`,
"profile avatar HTML"
);

// Replace profile updater
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
  avatar.textContent = name.charAt(0).toUpperCase();

  if (currentUser?.profile_picture) {
    const img = document.createElement("img");
    img.src = currentUser.profile_picture;
    img.alt = "Profile photo";
    avatar.textContent = "";
    avatar.appendChild(img);
  }
}

$("avatarInput").addEventListener("change", async function() {
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
}`,
"profile updater and upload handler"
);

// Validate extracted script without regex
const start = html.indexOf("<script");
const open = html.indexOf(">", start);
const close = html.indexOf("</script>", open);

if (start < 0 || open < 0 || close < 0) {
  throw Error("Could not locate script");
}

fs.writeFileSync("avatar-check.js", html.slice(open + 1, close));

const check = cp.spawnSync("node", ["--check", "avatar-check.js"], {
  encoding: "utf8"
});

if (check.status !== 0) {
  console.error(check.stderr);
  throw Error("Validation failed. Original HTML was not changed.");
}

fs.copyFileSync(file, "backups/index-before-avatar.html");
fs.writeFileSync(file, html);

console.log("SUCCESS: Profile photo upload installed and validated.");
