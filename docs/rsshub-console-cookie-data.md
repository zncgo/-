# RSSHub 控制台 Cookie 本地数据

Cookie 是登录凭据。本项目不会把 Cookie、Cookie 摘要或 Cookie 内容写入 Git、镜像、接口响应或日志；不要提交、外发或共享 `rsshub-console-data` 目录。

## 数据位置

默认宿主机用户数据根目录为 `E:/更新频率表/rsshub-console-data`。Compose 将其中的 `cookies` 子目录挂载到容器内的 `/cookies`：UI 可写，RSSHub 只读。可在启动前设置 `RSSHUB_USER_DATA_DIR` 覆盖根目录；浏览器界面不会显示该绝对路径。

CookiePool 的 `.state` 和 `.trash` 均保留在该 `cookies` 目录中。因而刷新页面、重启 UI 容器或重建镜像不会丢失导入的 Cookie。备份时，在停止容器后复制整个用户数据根目录到受保护的离线位置。

## 从旧命名卷迁移

旧卷 `rsshub-cookie-data` 会保留，不会被脚本删除。若旧数据位于该卷，停止服务后运行：

```powershell
cd E:\RSSHub
.\scripts\migrate-cookie-data.ps1
docker compose up -d
```

若旧数据已位于宿主机目录（例如 `E:\更新频率表\cookies`），改为显式指定只读来源：

```powershell
.\scripts\migrate-cookie-data.ps1 -SourceDirectory 'E:\更新频率表\cookies'
docker compose up -d
```

脚本只读取旧卷或旧宿主机目录；目标目录非空时立即停止且不会覆盖。它先复制到临时目录，校验总文件数和全部 JSON，再原子改名为 `cookies`，并写入不含凭据的 `.cookie-migration.json` 结果摘要。

若已有目标目录，先确认它是不是已经迁移完成的数据；不要删除或覆盖其中的内容。需要改用其他用户数据根目录时，设置 `RSSHUB_USER_DATA_DIR` 后再运行迁移。

## 回滚

停止 Compose，恢复使用本次变更前的 `docker-compose.yml`（或检出此前提交），再启动服务即可重新挂载旧的 `rsshub-cookie-data` 命名卷。旧卷始终保留，因此迁移失败或回滚不会要求重新导入 Cookie。

Cookie 管理页的普通删除会进入 30 天回收区；永久删除仅针对回收区的单条记录，且不可恢复。
