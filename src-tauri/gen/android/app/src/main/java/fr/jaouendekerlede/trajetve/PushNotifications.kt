package fr.jaouendekerlede.trajetve

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

// Notifications push (Firebase) -- demande explicite de l'utilisateur le 2026-10-30. Récupère le
// jeton FCM de cet appareil et l'envoie au relais TrajetVE, pour qu'il puisse envoyer de vraies
// notifications (charge 100 %, batterie basse, avertissement véhicule, déplacement suspect)
// même appli fermée. Volontairement en Kotlin pur, sans passer par le pont Tauri/JS (aucun code
// JS n'appelle Tauri dans cette appli -- inutile d'en introduire un rien que pour ça). Pas de
// FirebaseMessagingService personnalisé : les notifications envoyées par le relais sont de type
// "notification", affichées automatiquement par le système même appli fermée.
object PushNotifications {
  fun initialiser(activity: MainActivity) {
    demanderPermission(activity)
    envoyerJetonAuRelais()
  }

  private fun demanderPermission(activity: MainActivity) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
      }
    }
  }

  private fun envoyerJetonAuRelais() {
    FirebaseMessaging.getInstance().token.addOnCompleteListener { tache ->
      if (!tache.isSuccessful) return@addOnCompleteListener
      val jeton = tache.result ?: return@addOnCompleteListener
      Executors.newSingleThreadExecutor().execute {
        try {
          val url = URL("${Secrets.RELAIS_URL}/fcm-token?cle_lecture=${Secrets.CLE_LECTURE}")
          val connexion = url.openConnection() as HttpURLConnection
          connexion.requestMethod = "POST"
          connexion.doOutput = true
          connexion.setRequestProperty("Content-Type", "application/json")
          connexion.outputStream.use { it.write("{\"jeton\":\"$jeton\"}".toByteArray()) }
          connexion.responseCode // force l'envoi de la requête
          connexion.disconnect()
        } catch (e: Exception) {
          // Sans conséquence -- retenté au prochain lancement de l'appli.
        }
      }
    }
  }
}
