// Uzat yordamchisi: stdin'dan qatorlab buyruq o'qib, Windows SendInput orqali sichqoncha va klaviaturani boshqaradi.
// Buyruqlar (koordinatalar — jismoniy piksellarda, virtual ish stoli bo'yicha):
//   m X Y        — kursorni ko'chirish
//   d l|r|m      — tugmani bosib turish,  u l|r|m — qo'yib yuborish
//   w D          — vertikal g'ildirak (D: 120 = bir "chiq"),  h D — gorizontal
//   t BASE64     — UTF-8 matnni yozish
//   k VK         — tugmani bosib qo'yish (masalan 13 = Enter, 8 = Backspace)
//   p            — "pong" (tirikligini tekshirish), q — chiqish
using System;
using System.Runtime.InteropServices;
using System.Text;

static class UzatInput
{
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy, mouseData; public uint dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }

    const uint MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010, MDOWN = 0x0020, MUP = 0x0040;
    const uint WHEEL = 0x0800, HWHEEL = 0x1000, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000;
    const uint KEYUP = 0x0002, UNICODE = 0x0004;

    static void Mouse(uint flags, int dx = 0, int dy = 0, int data = 0)
    {
        var i = new INPUT[1];
        i[0].type = 0;
        i[0].u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags };
        SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
    }

    static void Key(ushort vk, ushort scan, uint flags)
    {
        var i = new INPUT[1];
        i[0].type = 1;
        i[0].u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
        SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
    }

    static void MoveTo(int x, int y)
    {
        int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
        int nx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
        int ny = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
        Mouse(MOVE | ABSOLUTE | VIRTUALDESK, nx, ny);
    }

    static uint Btn(string b, bool down)
    {
        if (b == "r") return down ? RDOWN : RUP;
        if (b == "m") return down ? MDOWN : MUP;
        return down ? LDOWN : LUP;
    }

    static int Main()
    {
        SetProcessDPIAware();
        Console.InputEncoding = Encoding.UTF8;
        Console.WriteLine("ready");
        Console.Out.Flush();
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            try
            {
                var p = line.Trim().Split(' ');
                switch (p[0])
                {
                    case "m": MoveTo(int.Parse(p[1]), int.Parse(p[2])); break;
                    case "d": Mouse(Btn(p.Length > 1 ? p[1] : "l", true)); break;
                    case "u": Mouse(Btn(p.Length > 1 ? p[1] : "l", false)); break;
                    case "w": Mouse(WHEEL, 0, 0, int.Parse(p[1])); break;
                    case "h": Mouse(HWHEEL, 0, 0, int.Parse(p[1])); break;
                    case "k":
                        var vk = ushort.Parse(p[1]);
                        Key(vk, 0, 0);
                        Key(vk, 0, KEYUP);
                        break;
                    case "t":
                        foreach (char c in Encoding.UTF8.GetString(Convert.FromBase64String(p[1])))
                        {
                            Key(0, c, UNICODE);
                            Key(0, c, UNICODE | KEYUP);
                        }
                        break;
                    case "c":
                        POINT pt;
                        GetCursorPos(out pt);
                        Console.WriteLine("c " + pt.X + " " + pt.Y);
                        Console.Out.Flush();
                        break;
                    case "p": Console.WriteLine("pong"); Console.Out.Flush(); break;
                    case "q": return 0;
                }
            }
            catch (Exception) { }
        }
        return 0;
    }
}
