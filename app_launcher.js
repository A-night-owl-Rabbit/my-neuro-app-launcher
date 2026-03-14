/**
 * MCP 应用启动器工具 (App Launcher v1.0)
 * 
 * 功能：让AI助手帮助用户启动Windows电脑上的各种应用程序，支持自动扫描桌面快捷方式
 * 作者：爱熬夜的人形兔
 * 版本：1.0.0
 * 
 * 特性：
 * - 自动扫描桌面上的 .exe、.lnk、.url 文件
 * - 支持启动本地应用程序（.exe）
 * - 支持打开网页链接（http/https）
 * - 支持 Steam 游戏链接（steam://）
 * - 应用名称匹配不区分大小写
 * - 正确处理中文路径和中文应用名称
 * 
 * --- 依赖安装 ---
 * 在本目录运行: npm install
 * 或手动安装: npm install iconv-lite
 * 
 * --- 配置文件 ---
 * apps.json: 存储应用名称与路径的映射，首次运行自动生成
 */

const fs = require('fs').promises;
const path = require('path');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const iconv = require('iconv-lite');
const execAsync = promisify(exec);

// 配置文件名
const CONFIG_FILE = 'apps.json';

// 标记是否已经扫描过桌面
let hasScanned = false;

// 1. 定义工具
const LAUNCH_APP_TOOL = {
    name: "launch_application",
    description: "根据应用名称启动用户电脑上的一个指定应用程序。应用名称已经在apps.json中预先配置。",
    parameters: {
        type: "object",
        properties: {
            appName: {
                type: "string",
                description: "要启动的应用程序的名称，例如 'QQ', '记事本', '计算器' 等。必须与apps.json中的键名匹配（不区分大小写）。"
            }
        },
        required: ["appName"]
    }
};

/**
 * 使用 PowerShell 获取真实的桌面路径（解决中文系统问题）
 * @private
 * @returns {Promise<string>} 桌面路径。
 */
async function getDesktopPath() {
    try {
        const { stdout } = await execAsync(
            `chcp 65001 > nul && powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`,
            { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }
        );
        const desktopPath = iconv.decode(stdout, 'utf8').trim();
        if (desktopPath && desktopPath.length > 0) {
            return desktopPath;
        }
    } catch (error) {
        console.warn(`[AppLauncher] PowerShell 获取桌面路径失败: ${error.message}`);
    }
    
    // 回退方案：尝试多种可能的路径
    const userProfile = process.env.USERPROFILE;
    const possiblePaths = [
        path.join(userProfile, 'Desktop'),
        path.join(userProfile, '桌面'),
        path.join(userProfile, 'OneDrive', 'Desktop'),
        path.join(userProfile, 'OneDrive', '桌面'),
    ];
    
    for (const p of possiblePaths) {
        try {
            await fs.access(p);
            return p;
        } catch (e) {}
    }
    
    return path.join(userProfile, 'Desktop');
}

/**
 * 使用PowerShell解析.lnk快捷方式文件，正确处理中文路径。
 * @private
 * @param {string} lnkPath - 快捷方式文件的完整路径。
 * @returns {Promise<string|null>} 返回目标路径，失败则返回null。
 */
async function resolveLnkPath(lnkPath) {
    const tempScriptPath = path.join(__dirname, `temp_resolve_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.ps1`);
    
    try {
        // 创建临时PowerShell脚本文件，使用 UTF-8 BOM 编码确保中文路径正确
        const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut("${lnkPath.replace(/\\/g, '\\\\').replace(/'/g, "''")}")
Write-Output $shortcut.TargetPath
`;
        // 写入带 BOM 的 UTF-8
        const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
        const content = Buffer.concat([BOM, Buffer.from(psScript, 'utf8')]);
        await fs.writeFile(tempScriptPath, content);
        
        // 执行PowerShell脚本，使用buffer模式读取输出
        const { stdout, stderr } = await execAsync(
            `chcp 65001 > nul && powershell -NoProfile -ExecutionPolicy Bypass -File "${tempScriptPath}"`,
            { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }
        );
        
        // 使用iconv-lite将buffer转换为UTF-8字符串
        const targetPath = iconv.decode(stdout, 'utf8').trim();
        
        if (stderr && stderr.length > 0) {
            const errMsg = iconv.decode(stderr, 'utf8');
            if (errMsg && !errMsg.includes('ProgressPreference') && !errMsg.includes('Active code page')) {
                console.warn(`[AppLauncher] PowerShell警告: ${errMsg}`);
            }
        }
        
        return targetPath || null;
    } catch (error) {
        console.warn(`[AppLauncher] 解析快捷方式失败 ${lnkPath}:`, error.message);
        return null;
    } finally {
        // 清理临时脚本文件
        try {
            await fs.unlink(tempScriptPath);
        } catch (e) {
            // 忽略删除失败
        }
    }
}

/**
 * 解析.url文件（Internet快捷方式）。
 * @private
 * @param {string} urlPath - .url文件的完整路径。
 * @returns {Promise<string|null>} 返回URL地址，失败则返回null。
 */
async function resolveUrlPath(urlPath) {
    try {
        const content = await fs.readFile(urlPath, 'utf8');
        
        // .url 文件格式类似 INI，查找 URL= 开头的行
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('URL=')) {
                const url = trimmed.substring(4).trim();
                if (url) {
                    return url;
                }
            }
        }
        
        return null;
    } catch (error) {
        console.warn(`[AppLauncher] 解析Internet快捷方式失败 ${urlPath}:`, error.message);
        return null;
    }
}

/**
 * 获取公共桌面路径
 * @private
 * @returns {Promise<string>} 公共桌面路径。
 */
async function getPublicDesktopPath() {
    try {
        const { stdout } = await execAsync(
            `chcp 65001 > nul && powershell -NoProfile -Command "[Environment]::GetFolderPath('CommonDesktopDirectory')"`,
            { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }
        );
        const desktopPath = iconv.decode(stdout, 'utf8').trim();
        if (desktopPath && desktopPath.length > 0) {
            return desktopPath;
        }
    } catch (error) {}
    
    return 'C:\\Users\\Public\\Desktop';
}

/**
 * 扫描指定目录的应用程序
 * @private
 * @param {string} dirPath - 要扫描的目录路径
 * @param {object} scannedApps - 用于存储扫描结果的对象
 * @param {string} dirName - 目录名称（用于日志）
 * @returns {Promise<number>} 返回扫描到的新应用数量
 */
async function scanDirectory(dirPath, scannedApps, dirName) {
    try {
        const files = await fs.readdir(dirPath);
        let count = 0;
        
        for (const file of files) {
            const fullPath = path.join(dirPath, file);
            const ext = path.extname(file).toLowerCase();
            
            try {
                const stats = await fs.stat(fullPath);
                if (!stats.isFile()) continue;
                
                let appName = path.basename(file, ext);
                let appPath = null;
                
                if (ext === '.exe') {
                    appPath = fullPath;
                    console.log(`[AppLauncher] 扫描到应用: ${appName} -> ${fullPath}`);
                } else if (ext === '.lnk') {
                    const targetPath = await resolveLnkPath(fullPath);
                    if (targetPath) {
                        appPath = targetPath;
                        console.log(`[AppLauncher] 扫描到快捷方式: ${appName} -> ${targetPath}`);
                    }
                } else if (ext === '.url') {
                    const url = await resolveUrlPath(fullPath);
                    if (url) {
                        appPath = url;
                        console.log(`[AppLauncher] 扫描到网址快捷方式: ${appName} -> ${url}`);
                    }
                }
                
                if (appPath && !scannedApps[appName]) {
                    scannedApps[appName] = appPath;
                    count++;
                }
            } catch (fileError) {
                console.warn(`[AppLauncher] 处理文件 ${file} 时出错:`, fileError.message);
            }
        }
        
        return count;
    } catch (error) {
        console.warn(`[AppLauncher] 扫描${dirName}失败:`, error.message);
        return 0;
    }
}

/**
 * 扫描桌面上的应用程序（.exe、.lnk和.url文件）。
 * @private
 * @returns {Promise<object>} 返回扫描到的应用程序配置对象。
 */
async function scanDesktopApps() {
    const scannedApps = {};
    
    // 扫描用户桌面
    const userDesktop = await getDesktopPath();
    console.log(`[AppLauncher] 扫描用户桌面: ${userDesktop}`);
    await scanDirectory(userDesktop, scannedApps, '用户桌面');
    
    // 扫描公共桌面
    const publicDesktop = await getPublicDesktopPath();
    console.log(`[AppLauncher] 扫描公共桌面: ${publicDesktop}`);
    await scanDirectory(publicDesktop, scannedApps, '公共桌面');
    
    console.log(`[AppLauncher] 桌面扫描完成，共找到 ${Object.keys(scannedApps).length} 个应用`);
    
    return scannedApps;
}

/**
 * 合并新扫描的应用到现有配置中。
 * @private
 * @param {object} existingApps - 现有的应用配置。
 * @param {object} newApps - 新扫描到的应用配置。
 * @returns {object} 合并后的配置。
 */
function mergeApps(existingApps, newApps) {
    const merged = { ...existingApps };
    let addedCount = 0;
    
    for (const [appName, appPath] of Object.entries(newApps)) {
        // 如果应用名不存在，则添加
        if (!merged[appName]) {
            merged[appName] = appPath;
            addedCount++;
            console.log(`[AppLauncher] 添加新应用: ${appName}`);
        }
    }
    
    console.log(`[AppLauncher] 合并完成，新增 ${addedCount} 个应用`);
    return merged;
}

/**
 * 保存应用配置到JSON文件。
 * @private
 * @param {object} apps - 要保存的应用配置。
 * @returns {Promise<boolean>} 保存是否成功。
 */
async function saveApps(apps) {
    const configPath = path.join(__dirname, CONFIG_FILE);
    try {
        await fs.writeFile(configPath, JSON.stringify(apps, null, 4), 'utf-8');
        console.log(`[AppLauncher] 配置文件保存成功`);
        return true;
    } catch (error) {
        console.error(`[AppLauncher] 保存配置文件错误:`, error.message);
        return false;
    }
}

/**
 * 从JSON文件中异步加载应用程序列表。
 * @private
 * @returns {Promise<object|null>} 返回一个包含应用配置的对象，如果失败则返回null。
 */
async function loadApps() {
    const configPath = path.join(__dirname, CONFIG_FILE);
    
    // 首次加载时自动扫描桌面
    if (!hasScanned) {
        hasScanned = true;
        console.log(`[AppLauncher] 首次加载，开始扫描桌面应用...`);
        
        try {
            // 读取现有配置（如果存在）
            let existingApps = {};
            try {
                const data = await fs.readFile(configPath, 'utf-8');
                existingApps = JSON.parse(data);
            } catch (readError) {
                console.log(`[AppLauncher] 未找到现有配置文件，将创建新的`);
            }
            
            // 扫描桌面
            const scannedApps = await scanDesktopApps();
            
            // 合并配置
            const mergedApps = mergeApps(existingApps, scannedApps);
            
            // 保存合并后的配置
            await saveApps(mergedApps);
            
            return mergedApps;
        } catch (error) {
            console.error(`[AppLauncher] 自动扫描过程出错:`, error.message);
            // 如果扫描失败，尝试返回现有配置
        }
    }
    
    // 正常加载配置文件
    try {
        const data = await fs.readFile(configPath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error(`[AppLauncher] 读取配置文件错误:`, error.message);
        return null;
    }
}

// 2. 执行工具的函数
/**
 * 根据提供的参数启动应用程序。
 * @param {object} parameters - 包含appName的对象。
 * @param {string} parameters.appName - 要启动的应用名称。
 * @returns {Promise<string>} 返回操作结果的描述字符串。
 */
async function startApplication(parameters) {
    const appNameToLaunch = parameters.appName;
    if (!appNameToLaunch) {
        return "错误：未提供应用名称 (appName)。";
    }

    const apps = await loadApps();
    if (!apps) {
        return `错误：无法加载应用列表，请检查服务端的 ${CONFIG_FILE} 文件。`;
    }

    // 查找匹配的应用 (不区分大小写)
    const appKeys = Object.keys(apps);
    const foundKey = appKeys.find(key => key.toLowerCase() === appNameToLaunch.toLowerCase());

    if (foundKey) {
        const appPath = apps[foundKey];
        console.log(`[AppLauncher] 正在尝试启动 "${foundKey}"，路径: ${appPath}`);
        
        try {
            // 判断是否是URL（支持 http://, https://, steam:// 等各种协议）
            const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(appPath);
            
            if (isUrl) {
                // 使用默认程序打开URL（浏览器、Steam等）
                const child = spawn('cmd', ['/c', 'start', '', appPath], {
                    detached: true,
                    stdio: 'ignore',
                    shell: true
                });
                child.unref();
                
                return `已成功打开 "${foundKey}": ${appPath}`;
            } else {
                // 异步检查文件是否存在
                await fs.access(appPath);

                const child = spawn(`"${appPath}"`, [], {
                    detached: true,
                    stdio: 'ignore',
                    shell: true,
                    cwd: path.dirname(appPath)
                });
                child.unref();
                
                return `已成功发送启动 "${foundKey}" 的指令。`;
            }

        } catch (error) {
            console.error(`[AppLauncher] 启动 "${foundKey}" 失败:`, error);
            if (error.code === 'ENOENT') {
                return `错误：应用 "${foundKey}" 的路径 "${appPath}" 无效或文件不存在。`;
            }
            return `错误：启动 "${foundKey}" 时发生未知服务器错误。`;
        }
    } else {
        return `错误：在配置文件中未找到名为 "${appNameToLaunch}" 的应用。可用的应用有：${appKeys.join(', ')}。`;
    }
}

// 3. 必须导出这两个函数
module.exports = {
    /**
     * 返回此模块提供的所有工具的定义。
     * @returns {Array<object>} 工具定义列表。
     */
    getToolDefinitions: () => [LAUNCH_APP_TOOL],

    /**
     * 根据工具名称执行相应的功能。
     * @param {string} name - 要执行的工具的名称。
     * @param {object} parameters - 传递给工具的参数。
     * @returns {Promise<any>} 工具执行的结果。
     */
    executeFunction: async (name, parameters) => {
        if (name === "launch_application") {
            return await startApplication(parameters);
        } else {
            throw new Error(`[AppLauncher] 不支持此功能: ${name}`);
        }
    }
};