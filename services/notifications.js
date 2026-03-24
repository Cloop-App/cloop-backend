const prisma = require("../lib/prisma");

/**
 * Create an in-app notification for a user.
 * @param {string} userId
 * @param {string} title
 * @param {string} body
 * @param {string} [type='info'] - 'info' | 'welcome' | 'profile' | 'achievement'
 */
async function createNotification(userId, title, body, type = "info") {
  return prisma.notification.create({
    data: {
      user_id: userId,
      title,
      body,
      type,
    },
  });
}

/**
 * Send welcome-back notifications on login.
 * Fires asynchronously — caller does not await.
 * [Blocker #10] FIX: Added cooldown — skips if a welcome notification was sent
 * within the last 6 hours to prevent spam on repeated logins.
 * @param {string} userId
 * @param {string} userName
 */
async function sendLoginNotifications(userId, userName) {
  try {
    // Check for recent welcome notification (6-hour cooldown)
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const recentWelcome = await prisma.notification.findFirst({
      where: {
        user_id: userId,
        type: "welcome",
        created_at: { gte: sixHoursAgo },
      },
    });

    if (recentWelcome) {
      return; // Skip — already notified recently
    }

    await createNotification(
      userId,
      "Welcome back!",
      `Great to see you again, ${userName}! Ready to continue learning?`,
      "welcome"
    );

    await createNotification(
      userId,
      "Your Profile",
      "Check your profile to track your progress and manage your subjects.",
      "profile"
    );
  } catch (err) {
    console.error("Failed to send login notifications:", err.message);
  }
}

/**
 * Expo Push Notification sender.
 * NOTE: This is mobile-only. Web clients should skip the push-token registration.
 * For web, in-app notifications (stored in DB) are sufficient.
 */
async function sendPushNotification(expoPushToken, title, body) {
  // Only attempt if expo-server-sdk is available and token is provided
  if (!expoPushToken) return;

  try {
    const { Expo } = require("expo-server-sdk");
    const expo = new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN });

    if (!Expo.isExpoPushToken(expoPushToken)) {
      console.warn("Invalid Expo push token:", expoPushToken);
      return;
    }

    await expo.sendPushNotificationsAsync([
      {
        to: expoPushToken,
        sound: "default",
        title,
        body,
      },
    ]);
  } catch (err) {
    console.error("Push notification failed:", err.message);
  }
}

module.exports = { createNotification, sendLoginNotifications, sendPushNotification };
