import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// The Google Play upload key, read from OUTSIDE this repo — it is public, and the key and its
// passwords live in ~/.android-release/ on the release Mac the way the App Store Connect key lives in
// ~/.appstoreconnect/ (see mobile/RELEASE.md). HARNESS_ANDROID_SIGNING points elsewhere, for CI.
//
// ⚠️ Without it a release build falls back to the DEBUG key, so `flutter run --release` keeps working
// on every other machine. Play refuses a debug-signed bundle at upload, and
// scripts/release-android.sh refuses to build one in the first place.
val uploadKeyFile = file(
    System.getenv("HARNESS_ANDROID_SIGNING")
        ?: "${System.getProperty("user.home")}/.android-release/harness-upload.properties",
)
val uploadKey = Properties().apply {
    if (uploadKeyFile.exists()) uploadKeyFile.inputStream().use { load(it) }
}

// Firebase, for phone push (PushService.kt, task #2905): the values of the app's google-services.json, written as the
// string resources Firebase starts from by itself — what Google's Gradle plugin would generate, without that plugin.
// Not a secret: it names the Firebase project and app. Without the file the build has no push, and the app log says so.
val googleServices = file("google-services.json")
val firebase: Map<String, String> = if (!googleServices.exists()) emptyMap() else {
    @Suppress("UNCHECKED_CAST")
    fun Any?.asMap() = this as Map<String, Any?>
    @Suppress("UNCHECKED_CAST")
    fun Any?.asList() = this as List<Any?>
    val json = groovy.json.JsonSlurper().parse(googleServices).asMap()
    val project = json["project_info"].asMap()
    val client = json["client"].asList().map { it.asMap() }
        .first { it["client_info"].asMap()["android_client_info"].asMap()["package_name"] == "ai.autonomous.harness.android" }
    mapOf(
        "google_app_id" to client["client_info"].asMap()["mobilesdk_app_id"] as String,
        "google_api_key" to client["api_key"].asList().first().asMap()["current_key"] as String,
        "gcm_defaultSenderId" to project["project_number"] as String,
        "project_id" to project["project_id"] as String,
    )
}

android {
    namespace = "ai.autonomous.harness.android"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    // The Firebase values above go in as resValues, which AGP 9 leaves off unless asked.
    buildFeatures { resValues = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // flutter_local_notifications (the "agent finished" notice) needs java.time on every API level.
        isCoreLibraryDesugaringEnabled = true
    }

    defaultConfig {
        // ⚠️ Permanent: Play keys the app on this id, and it cannot change after the first upload.
        // Mirrors the iOS bundle id, ai.autonomous.harness.ios.
        applicationId = "ai.autonomous.harness.android"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Both from `version:` in pubspec.yaml — the same `+N` the iOS builds carry, which Play also
        // needs to rise with every upload.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        // A copy that installs beside the Play one, for the on-device benchmarks
        // (mobile/integration_test/README.md): `-P harnessIdSuffix=.bench`. A local build cannot
        // replace a Play install — Play re-signs the app with a key only Google holds — and
        // uninstalling it to make room signs the phone out.
        (project.findProperty("harnessIdSuffix") as String?)?.let { applicationIdSuffix = it }
        firebase.forEach { (name, value) -> resValue("string", name, value) }
    }

    signingConfigs {
        if (uploadKeyFile.exists()) {
            create("upload") {
                storeFile = file(uploadKey.getProperty("storeFile"))
                storePassword = uploadKey.getProperty("storePassword")
                keyAlias = uploadKey.getProperty("keyAlias")
                keyPassword = uploadKey.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("upload") ?: signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
    // Phone push (PushService.kt, task #2905): FCM's client, the only way to wake an Android app that is closed.
    implementation("com.google.firebase:firebase-messaging:24.1.0")
}
