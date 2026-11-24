using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Setup
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if ((args.Length == 1 && args[0] == "--manage") || (args.Length == 0 && ManagedLauncher.IsManagedExecutable()))
        {
            Application.Run(new ManageWindow(ManagedLauncher.ReadProject(), false));
            return;
        }
        if (args.Length == 0) Application.Run(new SetupWindow());
        else MessageBox.Show("无法识别启动参数。请从开始菜单打开飞书派单派单管理，或直接打开原安装包。", "飞书派单派单", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }
}

internal sealed class SetupWindow : Form
{
    private readonly TextBox projectPath = new TextBox();
    private readonly Button browse = new Button();
    private readonly RadioButton preserveStartup = new RadioButton();
    private readonly RadioButton enableStartup = new RadioButton();
    private readonly RadioButton disableStartup = new RadioButton();
    private readonly CheckBox resume = new CheckBox();
    private readonly Button install = new Button();
    private readonly Button checkUpdates = new Button();
    private readonly Button close = new Button();
    private readonly ProgressBar progress = new ProgressBar();
    private readonly TextBox result = new TextBox();
    private bool installing;

    internal SetupWindow()
    {
        Text = "飞书派单派单安装程序";
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Microsoft YaHei UI", 9F);
        MinimumSize = new Size(630, 465);
        ClientSize = new Size(660, 460);
        MaximizeBox = false;

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(20), ColumnCount = 1, RowCount = 9 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (int row = 0; row < 9; row++)
            layout.RowStyles.Add(new RowStyle(row == 7 ? SizeType.Percent : SizeType.AutoSize, row == 7 ? 100 : 0));

        var heading = new Label { Text = "更新现有派单系统", Font = new Font(Font.FontFamily, 16F, FontStyle.Bold), AutoSize = true, Margin = new Padding(0, 0, 0, 8) };
        layout.Controls.Add(heading, 0, 0);
        layout.Controls.Add(LabelFor("请用原任务所属 Windows 账号，选择这台生产电脑上正在使用的 v2 项目目录。"), 0, 1);

        var targetRow = new TableLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, ColumnCount = 2, Margin = new Padding(0, 6, 0, 12) };
        targetRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        targetRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        projectPath.ReadOnly = true;
        projectPath.Dock = DockStyle.Fill;
        projectPath.Margin = new Padding(0, 4, 6, 4);
        projectPath.AccessibleName = "现有生产项目路径";
        browse.Text = "浏览…";
        browse.AutoSize = true;
        browse.Click += BrowseProject;
        targetRow.Controls.Add(projectPath, 0, 0);
        targetRow.Controls.Add(browse, 1, 0);
        layout.Controls.Add(targetRow, 0, 2);

        layout.Controls.Add(LabelFor("登录后的启动方式"), 0, 3);
        var startupOptions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, WrapContents = false, FlowDirection = FlowDirection.TopDown, Margin = new Padding(0, 1, 0, 8) };
        preserveStartup.Text = "保留现有自启动设置";
        preserveStartup.Checked = true;
        enableStartup.Text = "登录 Windows 后自动运行";
        disableStartup.Text = "每次手动启动";
        foreach (var option in new[] { preserveStartup, enableStartup, disableStartup })
        {
            option.AutoSize = true;
            startupOptions.Controls.Add(option);
        }
        layout.Controls.Add(startupOptions, 0, 4);
        resume.Text = "安装后恢复原来正在运行的派单";
        resume.AutoSize = true;
        resume.Checked = true;
        resume.Margin = new Padding(0, 0, 0, 9);
        layout.Controls.Add(resume, 0, 5);

        progress.Dock = DockStyle.Fill;
        progress.Height = 13;
        progress.Margin = new Padding(0, 0, 0, 8);
        layout.Controls.Add(progress, 0, 6);
        result.ReadOnly = true;
        result.Multiline = true;
        result.ScrollBars = ScrollBars.Vertical;
        result.Dock = DockStyle.Fill;
        result.MinimumSize = new Size(100, 70);
        result.Text = "确认安装前，原派单会继续运行。";
        result.Margin = new Padding(0);
        result.AccessibleName = "安装进度和结果";
        layout.Controls.Add(result, 0, 7);

        var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, Margin = new Padding(0, 10, 0, 0) };
        install.Text = "检查并安装";
        install.AutoSize = true;
        install.Enabled = false;
        install.Click += ConfirmAndInstall;
        checkUpdates.Text = "检查更新";
        checkUpdates.AutoSize = true;
        checkUpdates.Enabled = ManagedLauncher.ReadProject() != null;
        checkUpdates.Click += delegate
        {
            using (var management = new ManageWindow(ManagedLauncher.ReadProject(), true)) management.ShowDialog(this);
        };
        close.Text = "关闭";
        close.AutoSize = true;
        close.Click += delegate { Close(); };
        buttons.Controls.Add(close);
        buttons.Controls.Add(checkUpdates);
        buttons.Controls.Add(install);
        layout.Controls.Add(buttons, 0, 8);
        Controls.Add(layout);
        AcceptButton = install;
        CancelButton = close;
        FormClosing += delegate(object sender, FormClosingEventArgs args) { if (installing) args.Cancel = true; };
    }

    private static Label LabelFor(string text)
    {
        return new Label { Text = text, AutoSize = true, Margin = new Padding(0, 2, 0, 2) };
    }

    private void BrowseProject(object sender, EventArgs args)
    {
        using (var dialog = new FolderBrowserDialog())
        {
            dialog.Description = "选择包含 production-v2、data 和现有配置的项目文件夹";
            dialog.ShowNewFolderButton = false;
            if (projectPath.Text.Length != 0) dialog.SelectedPath = projectPath.Text;
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            try
            {
                projectPath.Text = Path.GetFullPath(dialog.SelectedPath);
                install.Enabled = ExistingProject(projectPath.Text);
                result.Text = install.Enabled ? "已选择项目，请核对启动方式。" : "此文件夹缺少 v2 任务脚本、配置或数据库。请选择原生产项目。";
            }
            catch (Exception)
            {
                projectPath.Clear();
                install.Enabled = false;
                result.Text = "无法使用所选文件夹。";
            }
        }
    }

    internal static bool ExistingProject(string root)
    {
        return File.Exists(Path.Combine(root, "production-v2", "Task.ps1"))
            && File.Exists(Path.Combine(root, "config.workflow.local.json"))
            && File.Exists(Path.Combine(root, "data", "workflow.sqlite"));
    }

    private async void ConfirmAndInstall(object sender, EventArgs args)
    {
        string root = projectPath.Text;
        if (installing || root.Length == 0 || !ExistingProject(root))
        {
            result.Text = "找不到完整的原生产项目。请选择包含现有任务脚本、配置和数据库的文件夹。";
            return;
        }
        string startupMode = preserveStartup.Checked ? "preserve" : enableStartup.Checked ? "on" : "off";
        string startupLabel = preserveStartup.Checked ? preserveStartup.Text : enableStartup.Checked ? enableStartup.Text : disableStartup.Text;
        bool resumeRunning = resume.Checked;
        string confirmation = "安装位置\r\n" + root + "\r\n\r\n启动方式\r\n" + startupLabel
            + "\r\n\r\n" + (resumeRunning ? "若原派单正在运行，安装完成后会恢复它。原来停机的派单保持停机。" : "本次安装结束后暂不恢复派单。")
            + "\r\n\r\n首次升级会在这个现有项目中接入员工管理表。安装程序会核对原任务、有序停机并备份，继续使用原业务库。请在维护窗口使用原任务所属 Windows 账号继续。";
        if (MessageBox.Show(this, confirmation, "确认安装", MessageBoxButtons.OKCancel, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.OK) return;

        installing = true;
        SetInputAvailable(false);
        progress.Style = ProgressBarStyle.Marquee;
        result.Text = "正在检查、备份并更新。请等待安装程序完成。";
        try
        {
            var outcome = await Task.Run(() => EmbeddedInstaller.Run(root, startupMode, resumeRunning));
            result.Text = outcome.Message;
            if (outcome.Success) result.AppendText("\r\n\r\n" + ManagedLauncher.Save(root));
        }
        catch (Exception)
        {
            result.Text = "安装程序未能完成。请先核对原生产任务状态。错误码 SETUP_UNEXPECTED_FAILURE。";
        }
        finally
        {
            progress.Style = ProgressBarStyle.Blocks;
            installing = false;
            SetInputAvailable(true);
        }
    }

    private void SetInputAvailable(bool available)
    {
        browse.Enabled = available;
        preserveStartup.Enabled = available;
        enableStartup.Enabled = available;
        disableStartup.Enabled = available;
        resume.Enabled = available;
        install.Enabled = available && projectPath.Text.Length != 0 && ExistingProject(projectPath.Text);
        checkUpdates.Enabled = available && ManagedLauncher.ReadProject() != null;
        close.Enabled = available;
    }
}

internal sealed class ManageWindow : Form
{
    private readonly string projectRoot;
    private readonly Button check = new Button();
    private readonly Button apply = new Button();
    private readonly Button close = new Button();
    private readonly ProgressBar progress = new ProgressBar();
    private readonly TextBox result = new TextBox();
    private bool working;
    private string offeredVersion;

    internal ManageWindow(string projectRoot, bool checkOnShow)
    {
        this.projectRoot = projectRoot;
        Text = "飞书派单派单管理";
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Microsoft YaHei UI", 9F);
        ClientSize = new Size(660, 355);
        MinimumSize = new Size(620, 355);
        MaximizeBox = false;

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(20), ColumnCount = 1, RowCount = 5 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (int row = 0; row < 5; row++) layout.RowStyles.Add(new RowStyle(row == 3 ? SizeType.Percent : SizeType.AutoSize, row == 3 ? 100 : 0));
        layout.Controls.Add(new Label { Text = "派单版本更新", Font = new Font(Font.FontFamily, 16F, FontStyle.Bold), AutoSize = true }, 0, 0);
        var location = new TextBox { ReadOnly = true, Dock = DockStyle.Fill, Margin = new Padding(0, 10, 0, 12), Text = projectRoot ?? "未找到已安装的生产项目。", AccessibleName = "现有生产项目路径" };
        layout.Controls.Add(location, 0, 1);
        progress.Dock = DockStyle.Fill;
        progress.Height = 13;
        progress.Margin = new Padding(0, 0, 0, 8);
        layout.Controls.Add(progress, 0, 2);
        result.ReadOnly = true;
        result.Multiline = true;
        result.ScrollBars = ScrollBars.Vertical;
        result.Dock = DockStyle.Fill;
        result.MinimumSize = new Size(100, 70);
        result.Text = projectRoot == null ? "请用原任务所属 Windows 账号打开已交付的安装包并选择现有生产项目。" : "点击“检查更新”查看当前版本和可用版本。";
        result.AccessibleName = "更新进度和结果";
        layout.Controls.Add(result, 0, 3);
        var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, Margin = new Padding(0, 10, 0, 0) };
        close.Text = "关闭";
        close.AutoSize = true;
        close.Click += delegate { Close(); };
        apply.Text = "安装该版本";
        apply.AutoSize = true;
        apply.Enabled = false;
        apply.Click += ConfirmUpdate;
        check.Text = "检查更新";
        check.AutoSize = true;
        check.Enabled = projectRoot != null;
        check.Click += delegate { CheckForUpdate(); };
        buttons.Controls.Add(close);
        buttons.Controls.Add(apply);
        buttons.Controls.Add(check);
        layout.Controls.Add(buttons, 0, 4);
        Controls.Add(layout);
        AcceptButton = check;
        CancelButton = close;
        FormClosing += delegate(object sender, FormClosingEventArgs args) { if (working) args.Cancel = true; };
        if (checkOnShow) Shown += delegate { CheckForUpdate(); };
    }

    private void SetWorking(bool active)
    {
        working = active;
        progress.Style = active ? ProgressBarStyle.Marquee : ProgressBarStyle.Blocks;
        check.Enabled = !active && projectRoot != null;
        apply.Enabled = !active && offeredVersion != null;
        close.Enabled = !active;
    }

    private async void CheckForUpdate()
    {
        if (working || projectRoot == null) return;
        offeredVersion = null;
        SetWorking(true);
        result.Text = "正在检查版本。";
        try
        {
            SetupOutcome outcome = await Task.Run(() => EmbeddedInstaller.Check(projectRoot));
            offeredVersion = outcome.OfferedVersion;
            result.Text = outcome.Message;
        }
        catch (Exception) { result.Text = "更新检查未完成。错误码 SETUP_CHECK_FAILED。"; }
        finally { SetWorking(false); }
    }

    private async void ConfirmUpdate(object sender, EventArgs args)
    {
        if (working || offeredVersion == null || projectRoot == null) return;
        string version = offeredVersion;
        string confirmation = "安装版本 " + version + "\r\n\r\n" + projectRoot
            + "\r\n\r\n确认后会下载并校验这一版本。通过校验后，安装程序会在原项目有序停机、备份并更新，再恢复原来正在运行的派单。原启动设置继续使用。请在维护窗口继续。";
        if (MessageBox.Show(this, confirmation, "确认安装更新", MessageBoxButtons.OKCancel, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.OK) return;
        offeredVersion = null;
        SetWorking(true);
        result.Text = "正在下载、校验并安装所选版本。";
        try { result.Text = (await Task.Run(() => EmbeddedInstaller.Update(projectRoot, version))).Message; }
        catch (Exception) { result.Text = "更新结果无法确认。请核对原生产任务状态。错误码 SETUP_UPDATE_FAILED。"; }
        finally { SetWorking(false); }
    }
}

internal sealed class SetupOutcome
{
    internal string Message { get; private set; }
    internal bool Success { get; private set; }
    internal string OfferedVersion { get; private set; }
    internal SetupOutcome(string message, bool success = false, string offeredVersion = null)
    {
        Message = message;
        Success = success;
        OfferedVersion = offeredVersion;
    }
}

internal static class ManagedLauncher
{
    private const string FolderName = "ShiYeJiDispatch";
    private const string ProgramName = "Setup.exe";
    private const string PointerName = "project-path.txt";

    private static string DirectoryPath()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (!Path.IsPathRooted(local)) throw new IOException("Local application data is unavailable.");
        return Path.Combine(local, FolderName);
    }

    internal static bool IsManagedExecutable()
    {
        try { return SamePath(Assembly.GetExecutingAssembly().Location, Path.Combine(DirectoryPath(), ProgramName)); }
        catch (Exception) { return false; }
    }

    internal static string ReadProject()
    {
        try
        {
            string directory = DirectoryPath();
            if (!Directory.Exists(directory) || IsLinked(directory)) return null;
            var pointer = new FileInfo(Path.Combine(directory, PointerName));
            if (!pointer.Exists || IsLinked(pointer.FullName) || pointer.Length < 1 || pointer.Length > 4096) return null;
            string raw = File.ReadAllText(pointer.FullName, new UTF8Encoding(false, true)).Trim();
            if (!Path.IsPathRooted(raw) || raw.IndexOfAny(new[] { '\r', '\n', '\0' }) >= 0) return null;
            string project = Path.GetFullPath(raw);
            return string.Equals(raw, project, StringComparison.OrdinalIgnoreCase) && SetupWindow.ExistingProject(project) ? project : null;
        }
        catch (Exception) { return null; }
    }

    internal static string Save(string projectRoot)
    {
        string target;
        try
        {
            string directory = DirectoryPath();
            Directory.CreateDirectory(directory);
            if (IsLinked(directory)) throw new IOException("Linked management directory.");
            string source = Assembly.GetExecutingAssembly().Location;
            target = Path.Combine(directory, ProgramName);
            AssertOrdinaryIfPresent(target);
            if (!SamePath(source, target) && (!File.Exists(target) || !SameContents(source, target)))
                WriteAtomic(target, path => File.Copy(source, path));
            WriteAtomic(Path.Combine(directory, PointerName), path =>
            {
                using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                using (var writer = new StreamWriter(stream, new UTF8Encoding(false))) writer.WriteLine(Path.GetFullPath(projectRoot));
            });
        }
        catch (Exception) { return "本次安装已完成。更新管理入口未保存，状态码 SETUP_MANAGEMENT_SAVE_FAILED。"; }

        try
        {
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            if (!Path.IsPathRooted(programs) || !Directory.Exists(programs)) throw new IOException("Start Menu Programs is unavailable.");
            string shortcut = Path.Combine(programs, "飞书派单派单管理.lnk");
            WriteAtomic(shortcut, temporary => CreateShortcut(temporary, target), ".lnk");
            return "以后可从开始菜单打开“飞书派单派单管理”，检查和安装更新。";
        }
        catch (Exception) { return "开始菜单快捷方式未创建。可打开此管理程序检查更新：\r\n" + target; }
    }

    private static bool IsLinked(string filename)
    {
        return (File.GetAttributes(filename) & FileAttributes.ReparsePoint) != 0;
    }

    private static void AssertOrdinaryIfPresent(string filename)
    {
        try
        {
            FileAttributes attributes = File.GetAttributes(filename);
            if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) throw new IOException("Unexpected managed path.");
        }
        catch (FileNotFoundException) { }
    }

    private static bool SamePath(string first, string second)
    {
        return string.Equals(Path.GetFullPath(first), Path.GetFullPath(second), StringComparison.OrdinalIgnoreCase);
    }

    private static bool SameContents(string first, string second)
    {
        if (new FileInfo(first).Length != new FileInfo(second).Length) return false;
        using (SHA256 sha = SHA256.Create())
        using (Stream a = File.OpenRead(first))
        using (Stream b = File.OpenRead(second))
            return Convert.ToBase64String(sha.ComputeHash(a)) == Convert.ToBase64String(sha.ComputeHash(b));
    }

    private static void WriteAtomic(string destination, Action<string> write, string extension = ".tmp")
    {
        AssertOrdinaryIfPresent(destination);
        string temporary = Path.Combine(Path.GetDirectoryName(destination), ".shiyeji-" + Guid.NewGuid().ToString("N") + extension);
        try
        {
            write(temporary);
            AssertOrdinaryIfPresent(temporary);
            AssertOrdinaryIfPresent(destination);
            if (File.Exists(destination)) File.Replace(temporary, destination, null);
            else File.Move(temporary, destination);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static void CreateShortcut(string filename, string target)
    {
        Type type = Type.GetTypeFromProgID("WScript.Shell", true);
        object shell = Activator.CreateInstance(type);
        object shortcut = null;
        try
        {
            shortcut = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { filename });
            Type link = shortcut.GetType();
            link.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { target });
            link.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] { "--manage" });
            link.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { Path.GetDirectoryName(target) });
            link.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "检查和安装飞书派单派单更新" });
            link.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        }
        finally
        {
            if (shortcut != null) Marshal.FinalReleaseComObject(shortcut);
            Marshal.FinalReleaseComObject(shell);
        }
    }
}

internal static class EmbeddedInstaller
{
    private const string ResourceName = "ShiYeJiPayload";
    private const int MaxEntries = 16000;
    private const long MaxExpandedBytes = 1024L * 1024 * 1024;
    private static readonly Regex ReservedName = new Regex(@"^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex SafeCode = new Regex(@"^(?:[A-Z][A-Z0-9_]{2,90}|[0-9]{4,10})$", RegexOptions.CultureInvariant);
    private static readonly Regex SafeVersion = new Regex(@"\A2\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\z", RegexOptions.CultureInvariant);

    internal static SetupOutcome Run(string root, string startupMode, bool resumeRunning)
    {
        return RunController(root, false, "install", "--root", root, "--startup", startupMode, "--resume", resumeRunning ? "true" : "false");
    }

    internal static SetupOutcome Check(string root)
    {
        return RunController(root, true, "check", "--root", root);
    }

    internal static SetupOutcome Update(string root, string version)
    {
        if (string.IsNullOrEmpty(version) || !SafeVersion.IsMatch(version)) return new SetupOutcome("更新版本无效。错误码 SETUP_VERSION_INVALID。");
        return RunController(root, false, "update", "--root", root, "--version", version, "--startup", "preserve", "--resume", "true");
    }

    private static SetupOutcome RunController(string root, bool checkOnly, params string[] arguments)
    {
        string temporaryFolder = null;
        bool controllerLaunched = false;
        try
        {
            string tempParent = Path.GetFullPath(Path.GetTempPath());
            string chosenStage = Path.GetFullPath(Path.Combine(tempParent, "ShiyejiSetup-" + Guid.NewGuid().ToString("N")));
            if (!IsInside(chosenStage, tempParent) || Directory.Exists(chosenStage) || File.Exists(chosenStage))
                throw new IOException("Invalid staging path.");
            Directory.CreateDirectory(chosenStage);
            temporaryFolder = chosenStage;
            Extract(temporaryFolder);
            string node = Path.Combine(temporaryFolder, "runtime", "node.exe");
            string controller = Path.Combine(temporaryFolder, "controller.mjs");
            if (!File.Exists(node) || !File.Exists(controller))
                return new SetupOutcome("安装包缺少运行文件。错误码 SETUP_PAYLOAD_INCOMPLETE。");

            var start = new ProcessStartInfo
            {
                FileName = node,
                Arguments = QuoteArgument(controller) + " " + string.Join(" ", arguments.SelectQuoted()),
                WorkingDirectory = temporaryFolder,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            // Environment options such as --require would execute instructions outside the package.
            start.EnvironmentVariables.Remove("NODE_OPTIONS");
            start.EnvironmentVariables.Remove("NODE_PATH");
            start.EnvironmentVariables.Remove("NODE_INSPECT_RESUME_ON_START");
            start.EnvironmentVariables.Remove("NODE_CHANNEL_FD");
            using (var process = new Process { StartInfo = start })
            {
                if (!process.Start()) return new SetupOutcome("无法启动安装程序。错误码 SETUP_CONTROLLER_START_FAILED。");
                controllerLaunched = true;
                Task<string> stdout = DrainAsync(process.StandardOutput);
                Task<string> stderr = DrainAsync(process.StandardError);
                process.WaitForExit();
                string[] output = Task.WhenAll(stdout, stderr).GetAwaiter().GetResult();
                return checkOnly ? DescribeCheck(process.ExitCode, output[0]) : Describe(process.ExitCode, output[0], root);
            }
        }
        catch (InvalidDataException)
        {
            return new SetupOutcome("安装包校验失败。错误码 SETUP_PAYLOAD_INVALID。");
        }
        catch (Exception)
        {
            if (checkOnly) return new SetupOutcome("更新检查未完成。错误码 SETUP_CHECK_FAILED。");
            return new SetupOutcome(controllerLaunched
                ? "安装结果无法确认。请先核对原生产任务状态。错误码 SETUP_CONTROLLER_RESULT_UNKNOWN。"
                : "安装准备失败。错误码 SETUP_PREPARATION_FAILED。");
        }
        finally
        {
            if (temporaryFolder != null)
            {
                try { DeleteStagingDirectory(temporaryFolder, Path.GetFullPath(Path.GetTempPath())); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
    }

    // Keep a bounded diagnostic tail but drain both pipes so the controller cannot block on output.
    private static async Task<string> DrainAsync(StreamReader stream)
    {
        const int limit = 16 * 1024;
        var buffer = new char[4096];
        var stash = new StringBuilder();
        int count;
        while ((count = await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) != 0)
        {
            stash.Append(buffer, 0, count);
            if (stash.Length > limit) stash.Remove(0, stash.Length - limit);
        }
        return stash.ToString();
    }

    private static SetupOutcome Describe(int exitCode, string stdout, string projectRoot)
    {
        var codes = new HashSet<string>(StringComparer.Ordinal);
        var status = new Dictionary<string, object>(StringComparer.Ordinal);
        ReadStatus(stdout, status, codes);
        bool success = exitCode == 0 && HasBoolean(status, "ok", true);
        var summary = new StringBuilder();
        summary.AppendLine(success ? "安装操作已完成。" : "安装操作未确认完成。请先核对生产任务状态，再按下方信息处理。");
        if (success)
        {
            string version = TextValue(status, "version");
            if (SafeVersion.IsMatch(version)) summary.AppendLine("版本 " + version);
            if (HasBoolean(status, "staffBound", true)) summary.AppendLine("员工管理表已接入。");
            if (HasBoolean(status, "v22Configured", true)) summary.AppendLine("2.2 新增字段与运营查看已接入。");
            else if (HasBoolean(status, "v22Configured", false) && SafeVersion.IsMatch(version) && new Version(version).CompareTo(new Version("2.2.0")) >= 0)
                summary.AppendLine("当前项目未启用员工管理，本次完成程序升级。");
            if (HasBoolean(status, "resumed", true)) summary.AppendLine("原派单已恢复运行。");
            else if (HasBoolean(status, "resumed", false)) summary.AppendLine("本次安装没有启动派单。");
            if (HasBoolean(status, "healthVerified", true)) summary.AppendLine("运行状态检查已通过。");
            if (HasBoolean(status, "loginEnabled", true)) summary.AppendLine("登录后自动运行已启用。");
            else if (HasBoolean(status, "loginEnabled", false)) summary.AppendLine("登录后自动运行已关闭。");
        }
        else
        {
            if (exitCode == 0 && codes.Count == 0) codes.Add("SETUP_RESULT_UNCONFIRMED");
            if (HasBoolean(status, "startRequested", true)) summary.AppendLine("已请求恢复任务。请核对是否正在运行后再尝试恢复。");
            if (TextValue(status, "rollback") == "code_restored") summary.AppendLine("控制器已恢复原程序文件。");
            if (TextValue(status, "rollback") == "manual_recovery_required") summary.AppendLine("请保留下方恢复记录，安排排查后再继续。");
        }
        summary.AppendLine("退出码 " + exitCode);
        foreach (string code in codes) summary.AppendLine("状态码 " + code);
        AppendFolder(summary, status, "backupFolder", projectRoot, "backups", "数据备份");
        AppendFolder(summary, status, "recoveryDir", projectRoot, ".desktop-update", "安装记录");
        return new SetupOutcome(summary.ToString().TrimEnd(), success);
    }

    private static SetupOutcome DescribeCheck(int exitCode, string stdout)
    {
        var codes = new HashSet<string>(StringComparer.Ordinal);
        var status = new Dictionary<string, object>(StringComparer.Ordinal);
        ReadStatus(stdout, status, codes);
        string installed = TextValue(status, "installedVersion");
        string offered = TextValue(status, "version");
        bool available = HasBoolean(status, "updateAvailable", true);
        if (exitCode == 0 && HasBoolean(status, "ok", true) && SafeVersion.IsMatch(installed))
        {
            if (available && SafeVersion.IsMatch(offered) && new Version(offered).CompareTo(new Version(installed)) > 0)
                return new SetupOutcome("当前版本 " + installed + "\r\n可安装版本 " + offered + "\r\n\r\n如要更新，请点击“安装该版本”。", true, offered);
            if (HasBoolean(status, "updateAvailable", false))
                return new SetupOutcome("当前版本 " + installed + "\r\n没有可安装的新版本。", true);
        }
        var message = new StringBuilder("未能确认可用版本。\r\n退出码 " + exitCode);
        if (codes.Count == 0) codes.Add("SETUP_CHECK_RESULT_UNCONFIRMED");
        foreach (string code in codes) message.Append("\r\n状态码 " + code);
        return new SetupOutcome(message.ToString());
    }

    private static string TextValue(Dictionary<string, object> status, string key)
    {
        object value;
        return status.TryGetValue(key, out value) ? value as string ?? string.Empty : string.Empty;
    }

    private static void AppendFolder(StringBuilder summary, Dictionary<string, object> status, string key, string projectRoot, string subdirectory, string label)
    {
        string value = TextValue(status, key);
        if (value.Length == 0 || value.Length > 1024 || value.IndexOfAny(new[] { '\r', '\n', '\t', '\0' }) >= 0 || !Path.IsPathRooted(value)) return;
        try
        {
            string full = Path.GetFullPath(value);
            if (IsInside(full, Path.Combine(projectRoot, subdirectory))) summary.AppendLine(label + " " + full);
        }
        catch (ArgumentException) { }
        catch (IOException) { }
        catch (NotSupportedException) { }
    }

    private static bool HasBoolean(Dictionary<string, object> status, string key, bool expected)
    {
        object value;
        return status.TryGetValue(key, out value) && value is bool && (bool)value == expected;
    }

    private static void ReadStatus(string output, Dictionary<string, object> status, HashSet<string> codes)
    {
        var serializer = new JavaScriptSerializer { MaxJsonLength = 16384, RecursionLimit = 12 };
        string finalLine = output.TrimEnd();
        int previousLineEnd = finalLine.LastIndexOf('\n');
        if (previousLineEnd >= 0) finalLine = finalLine.Substring(previousLineEnd + 1);
        ReadStatusObject(finalLine.Trim(), serializer, status, codes);
    }

    private static void ReadStatusObject(string text, JavaScriptSerializer serializer, Dictionary<string, object> status, HashSet<string> codes)
    {
        if (!text.StartsWith("{", StringComparison.Ordinal) || !text.EndsWith("}", StringComparison.Ordinal)) return;
        Dictionary<string, object> values;
        try { values = serializer.Deserialize<Dictionary<string, object>>(text); }
        catch (ArgumentException) { return; }
        catch (InvalidOperationException) { return; }
        catch (FormatException) { return; }
        if (values == null) return;
        foreach (string key in new[] { "code", "errorCode" })
        {
            object value;
            if (values.TryGetValue(key, out value) && value is string && SafeCode.IsMatch((string)value) && codes.Count < 8)
                codes.Add((string)value);
        }
        foreach (string key in new[] { "ok", "resumed", "healthVerified", "staffBound", "v22Configured", "loginEnabled", "startRequested", "updateAvailable" })
        {
            object value;
            if (values.TryGetValue(key, out value) && value is bool) status[key] = value;
        }
        foreach (string key in new[] { "version", "backupFolder", "recoveryDir", "rollback", "installedVersion" })
        {
            object value;
            if (values.TryGetValue(key, out value) && value is string) status[key] = value;
        }
    }

    private static void Extract(string stage)
    {
        using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName))
        {
            if (payload == null) throw new InvalidDataException("Missing embedded payload.");
            using (var archive = new ZipArchive(payload, ZipArchiveMode.Read, false))
            {
                if (archive.Entries.Count == 0 || archive.Entries.Count > MaxEntries) throw new InvalidDataException("Invalid payload entry count.");
                var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                long remaining = MaxExpandedBytes;
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string name = entry.FullName.Replace('\\', '/');
                    bool directory = name.EndsWith("/", StringComparison.Ordinal);
                    string relative = directory ? name.Substring(0, name.Length - 1) : name;
                    var parts = relative.Split('/');
                    if ((entry.ExternalAttributes & (int)FileAttributes.ReparsePoint) != 0
                        || ((entry.ExternalAttributes >> 16) & 0xf000) == 0xa000)
                        throw new InvalidDataException("Linked payload entry.");
                    foreach (string part in parts) ValidateSegment(part);
                    if (!names.Add(relative.Normalize(NormalizationForm.FormC))) throw new InvalidDataException("Duplicate payload entry.");
                    string destination = Path.GetFullPath(Path.Combine(stage, relative.Replace('/', Path.DirectorySeparatorChar)));
                    if (!IsInside(destination, stage)) throw new InvalidDataException("Payload path escapes stage.");
                    if (entry.Length < 0 || entry.Length > remaining || (directory && entry.Length != 0))
                        throw new InvalidDataException("Expanded payload is too large.");
                    remaining -= entry.Length;
                    if (directory) { Directory.CreateDirectory(destination); continue; }

                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    using (Stream input = entry.Open())
                    using (var file = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        var buffer = new byte[65536];
                        long pending = entry.Length;
                        int count;
                        while ((count = input.Read(buffer, 0, buffer.Length)) != 0)
                        {
                            if (count > pending) throw new InvalidDataException("Payload length mismatch.");
                            file.Write(buffer, 0, count);
                            pending -= count;
                        }
                        if (pending != 0) throw new InvalidDataException("Truncated payload entry.");
                    }
                }
            }
        }
    }

    private static void ValidateSegment(string part)
    {
        if (part.Length == 0 || part.Length > 255 || part == "." || part == ".." || part.EndsWith(" ", StringComparison.Ordinal)
            || part.EndsWith(".", StringComparison.Ordinal) || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || ReservedName.IsMatch(part))
            throw new InvalidDataException("Invalid payload filename.");
    }

    private static bool IsInside(string candidate, string parent)
    {
        string prefix = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return Path.GetFullPath(candidate).StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }

    private static void DeleteStagingDirectory(string directory, string parent)
    {
        if (!IsInside(directory, parent)) throw new IOException("Invalid cleanup path.");
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) { Directory.Delete(directory, false); return; }
        foreach (string child in Directory.EnumerateDirectories(directory)) DeleteStagingDirectory(child, directory);
        foreach (string child in Directory.EnumerateFiles(directory)) File.Delete(child);
        Directory.Delete(directory, false);
    }

    private static string[] SelectQuoted(this string[] arguments)
    {
        var values = new string[arguments.Length];
        for (int index = 0; index < arguments.Length; index++) values[index] = QuoteArgument(arguments[index]);
        return values;
    }

    // Windows CRT quoting. In particular, a trailing backslash in a quoted path must be doubled.
    private static string QuoteArgument(string argument)
    {
        var quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') quoted.Append('\\', slashes * 2 + 1);
            else quoted.Append('\\', slashes);
            quoted.Append(character);
            slashes = 0;
        }
        quoted.Append('\\', slashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }
}
