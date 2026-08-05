#!/bin/bash
# 配置 @capgo/background-geolocation 原生后台定位
# 在 npx cap sync 之后执行
# CI 中也会自动调用

set -e

ANDROID_DIR="android/app/src/main"

# 1. 创建通知图标（插件默认使用 drawable/ic_tracking）
ICON_DIR="$ANDROID_DIR/res/drawable"
ICON_FILE="$ICON_DIR/ic_tracking.xml"
mkdir -p "$ICON_DIR"

if [ ! -f "$ICON_FILE" ]; then
  cat > "$ICON_FILE" << 'ICONEOF'
<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M12,2C8.13,2 5,5.13 5,9c0,5.25 7,13 7,13s7,-7.75 7,-13  -3.13,-7 -7,-7zM12,11.5c-1.38,0 -2.5,-1.12 -2.5,-2.5s1.12,-2.5 2.5,-2.5 2.5,1.12 2.5,2.5 -1.12,2.5 -2.5,2.5z"/>
</vector>
ICONEOF
  echo "+ ic_tracking.xml 通知图标"
fi

# 2. 配置插件通知渠道名称
STRINGS_FILE="$ANDROID_DIR/res/values/strings.xml"
mkdir -p "$(dirname "$STRINGS_FILE")"

if [ ! -f "$STRINGS_FILE" ]; then
  cat > "$STRINGS_FILE" << 'STRINGSEOF'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="capacitor_background_geolocation_notification_channel_name">位置追踪</string>
    <string name="capacitor_background_geolocation_notification_icon">drawable/ic_tracking</string>
</resources>
STRINGSEOF
  echo "+ strings.xml 通知渠道配置"
else
  # 检查是否已有插件配置
  if ! grep -q "capacitor_background_geolocation" "$STRINGS_FILE" 2>/dev/null; then
    sed -i 's|</resources>|    <string name="capacitor_background_geolocation_notification_channel_name">位置追踪</string>\n    <string name="capacitor_background_geolocation_notification_icon">drawable/ic_tracking</string>\n</resources>|' "$STRINGS_FILE"
    echo "+ strings.xml 已追加通知渠道配置"
  fi
fi

# 3. 确保 gradle.properties 包含 android.useLegacyBridge
GRADLE_PROPS="android/gradle.properties"
if [ -f "$GRADLE_PROPS" ]; then
  if ! grep -q "android.useLegacyBridge" "$GRADLE_PROPS" 2>/dev/null; then
    echo -e "\n# @capgo/background-geolocation: 防止 5 分钟后台定位停止\nandroid.useLegacyBridge=true" >> "$GRADLE_PROPS"
    echo "+ gradle.properties: android.useLegacyBridge=true"
  fi
fi

echo "✓ 后台定位原生配置完成"
