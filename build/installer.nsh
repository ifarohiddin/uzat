; O'rnatishda Windows Firewall'ga Uzat uchun kiruvchi ruxsat qo'shamiz (Private va Public tarmoqlar —
; Windows hotspot ko'pincha "Public" bo'ladi). O'chirishda qoida ham o'chiriladi.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Uzat"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Uzat" dir=in action=allow program="$INSTDIR\Uzat.exe" enable=yes profile=any'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Uzat"'
!macroend
