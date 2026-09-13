# Captura — Scanner de imagens

Aplicativo para analisar páginas públicas, exibir miniaturas das imagens encontradas, selecionar arquivos e baixar tudo em um ZIP.

## Recursos

- encontra imagens em `img`, `picture`, `srcset`, metadados sociais e CSS;
- prioriza a maior variante informada pela página;
- mostra miniaturas, formato e dimensões;
- permite filtrar e selecionar imagens;
- gera um ZIP com os arquivos selecionados;
- bloqueia tentativas de acesso a endereços locais e privados.

## Requisitos

- Node.js 22.13 ou superior;
- pnpm 11 ou superior.

## Rodar no computador

```bash
pnpm install
pnpm dev
```

Abra `http://localhost:5173`.

## Criar o repositório Git

```bash
git init
git add .
git commit -m "Adicionar Captura — scanner de imagens"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/captura-imagens.git
git push -u origin main
```

## Hospedagem

Este projeto **não funciona integralmente no GitHub Pages**, pois o GitHub Pages aceita somente arquivos estáticos. A varredura de páginas, o proxy de miniaturas e a geração do ZIP usam as rotas de servidor em `app/api`.

### Cloudflare Workers

Depois de autenticar o Wrangler na sua conta Cloudflare:

```bash
pnpm install
pnpm build
pnpm exec wrangler deploy --config dist/server/wrangler.json
```

Também é possível adaptar o projeto para outro serviço com suporte a funções de servidor. Alguns sites bloqueiam varreduras automáticas ou carregam imagens apenas depois da execução de scripts no navegador.

## Uso responsável

Baixe somente imagens que você tenha permissão para utilizar e respeite os direitos autorais e os termos do site analisado.
