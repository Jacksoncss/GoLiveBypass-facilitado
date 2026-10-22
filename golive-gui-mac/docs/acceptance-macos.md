# Checklist de aceitação — macOS

## Antes de publicar uma release

### Build
- [ ] `npm run build:ts` sem erros de TypeScript
- [ ] `npm run dist:mac` produz `GoLiveBypass-macos-<versão>-universal.dmg` (~186 MB)
- [ ] `file GoLiveBypass.app/Contents/MacOS/GoLiveBypass` mostra `universal binary`

### Instalação
- [ ] DMG abre sem erro
- [ ] Arrastar para /Applications funciona
- [ ] Primeira ativação pede senha de administrador (helper install)
- [ ] Ativações subsequentes NÃO pedem senha

### Bypass
- [ ] Go Live disponível durante bypass ativo
- [ ] Verificar IP de saída: `curl -4 https://ifconfig.co` retorna IP não-BR
- [ ] IPv6 não vaza pela VPN: `curl -6 https://ifconfig.co` retorna IP local direto

### Split tunnel
- [ ] Sonobus e outros apps de áudio continuam funcionando com bypass ativo
- [ ] Apenas ranges do Discord vão pela VPN (`netstat -rn` mostra rotas utun* para 162.159.x.x e 104.16-31.x.x)

### Shutdown gracioso
- [ ] Com bypass ativo, "Desligar Mac" no menu Apple funciona normalmente
- [ ] App desativa o túnel antes de encerrar (sem processo wg travado)
- [ ] Suspensão (tampa fechada) derruba o túnel corretamente

### Auto-reconexão
- [ ] Fechar e reabrir o app com bypass previamente ativo → reconecta automaticamente
- [ ] Estado correto mostrado na UI após reconexão
- [ ] Abrir ao iniciar a sessão ligado: depois de um logout real o app sobe só na barra de menu e religa o bypass

### Desativação adiada
- [ ] Desativar com o Discord aberto deixa o estado pendente; o túnel cai quando o Discord fecha
- [ ] Ativar durante a espera cancela a desativação sem reiniciar o Discord
- [ ] Desativar agora derruba na hora
- [ ] Matar o app durante a espera (`kill -9`) e reabrir: com o Discord aberto a espera volta; com ele fechado o túnel cai no boot
- [ ] Se o `down` falhar depois de o Discord fechar, aparece Restaurar internet

### Rotas Proton
- [ ] Entrar e buscar rota mostra o plano e a lista MX/US com ping
- [ ] Rota manual: escolher um servidor na lista valida com `-manual-probe` e mantém a escolha após reativar
- [ ] Otimizar rota com o bypass ativo não fecha o Discord e mostra ↓/↑ medidos
- [ ] Troca automática: com a rota caída, três sondas depois o app troca de servidor sem reiniciar o Discord

### Interface
- [ ] Reiniciar bypass e Restaurar internet funcionam com o túnel ativo
- [ ] Card de ping mostra a latência até o Discord pelo túnel
- [ ] Tema Sistema, Claro e Escuro trocam a janela na hora
- [ ] Checar atualizações responde mesmo com clique repetido durante a busca
- [ ] Ícone do Dock e da barra de menu com a rosa; o da barra segue o tema
