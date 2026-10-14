# Captura — Scanner de imagens

Aplicativo para analisar páginas públicas, exibir miniaturas das imagens encontradas, selecionar arquivos e baixar tudo em um ZIP.

## Recursos

- encontra imagens em `img`, `picture`, `srcset`, metadados sociais e CSS;
- prioriza a maior variante informada pela página;
- para galerias `nhentai.net/g/...`, consulta a API v2 da galeria e usa os arquivos das páginas em resolução original, separados das miniaturas;
- mostra miniaturas, formato e dimensões do arquivo selecionado;
- permite ampliar, navegar entre imagens, filtrar e selecionar para download;
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

O frontend estático está pronto para o GitHub Pages nos arquivos da raiz:

- `index.html`;
- `styles.css`;
- `app.js`;
- `favicon.svg`;
- `.nojekyll`.

Em **Settings → Pages**, selecione **Deploy from a branch**, a branch `main` e a pasta `/ (root)`.

### Cloudflare Workers

O backend já está publicado em:

`https://captura-imagens-api.maiconsantossilvah-captura.workers.dev`

O `index.html` já usa esse endereço. O código da API fica em `worker/worker.js`. Para publicar alterações futuras:

```bash
npx wrangler deploy --config worker/wrangler.toml
```

O Worker está configurado para aceitar o domínio `https://maiconsantossilvah-dot.github.io`. Se usar um domínio próprio, altere `ALLOWED_ORIGIN` em `worker/wrangler.toml` e publique novamente. Alguns sites bloqueiam varreduras automáticas ou carregam imagens apenas depois da execução de scripts no navegador.

Para disponibilizar mudanças neste repositório, publique o frontend no GitHub Pages e execute novamente o deploy do Worker. A versão local do scanner de galerias também fica em `app/api/scan/route.ts` para quem roda a aplicação com `pnpm dev`.

## Uso responsável

Baixe somente imagens que você tenha permissão para utilizar e respeite os direitos autorais e os termos do site analisado.
