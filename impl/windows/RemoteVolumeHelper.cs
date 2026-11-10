// Remote Volume Windows helper.
//
// A long-running process that talks Core Audio (WASAPI) and is driven over stdin/stdout:
// one command per input line, exactly one JSON object per output line.
//
// Commands:
//   get                      -> {"volume":50,"muted":false,"device":"Speakers (Realtek(R) Audio)"}
//   set-volume <0-100>       -> same as get, after applying
//   set-mute <0|1>           -> same as get, after applying
//   apps                     -> {"apps":[{"pid":1234,"name":"Spotify","title":"Spotify","volume":100,"muted":false,"active":true,"device":"Speakers"}]}
//   app-volume <pid> <0-100> -> {"ok":true,"count":<sessions changed>}
//   app-mute <pid> <0|1>     -> {"ok":true,"count":<sessions changed>}
//   ping                     -> {"ok":true}
// Errors are reported as {"error":"message"}.
//
// Targets .NET Framework 4 (present on every Windows 10/11 install) and only uses C# 5 features,
// so it can be compiled with the csc.exe that ships with Windows. See scripts/build-win-helper.js.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace RemoteVolume
{
	enum EDataFlow { Render = 0, Capture = 1, All = 2 }
	enum ERole { Console = 0, Multimedia = 1, Communications = 2 }

	[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
	class MMDeviceEnumeratorComObject { }

	// COM interfaces only declare methods up to the last one used; vtable order must match the SDK headers.

	[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IMMDeviceEnumerator
	{
		void EnumAudioEndpoints(EDataFlow dataFlow, int stateMask, out IMMDeviceCollection devices);
		[PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice device);
	}

	[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IMMDeviceCollection
	{
		void GetCount(out int count);
		void Item(int index, out IMMDevice device);
	}

	[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IMMDevice
	{
		void Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
		void OpenPropertyStore(int stgmAccess, out IPropertyStore properties);
		void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
	}

	[StructLayout(LayoutKind.Sequential)]
	struct PropertyKey
	{
		public Guid fmtid;
		public int pid;
	}

	[StructLayout(LayoutKind.Explicit, Size = 24)]
	struct PropVariant
	{
		[FieldOffset(0)] public ushort vt;
		[FieldOffset(8)] public IntPtr pointerValue;
	}

	[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IPropertyStore
	{
		void GetCount(out int count);
		void GetAt(int index, out PropertyKey key);
		void GetValue(ref PropertyKey key, out PropVariant value);
	}

	[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IAudioEndpointVolume
	{
		void RegisterControlChangeNotify(IntPtr notify);
		void UnregisterControlChangeNotify(IntPtr notify);
		void GetChannelCount(out int count);
		void SetMasterVolumeLevel(float levelDb, ref Guid eventContext);
		void SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
		void GetMasterVolumeLevel(out float levelDb);
		void GetMasterVolumeLevelScalar(out float level);
		void SetChannelVolumeLevel(int channel, float levelDb, ref Guid eventContext);
		void SetChannelVolumeLevelScalar(int channel, float level, ref Guid eventContext);
		void GetChannelVolumeLevel(int channel, out float levelDb);
		void GetChannelVolumeLevelScalar(int channel, out float level);
		void SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
		void GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
	}

	[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IAudioSessionManager2
	{
		void GetAudioSessionControl(IntPtr sessionGuid, int streamFlags, out IntPtr sessionControl);
		void GetSimpleAudioVolume(IntPtr sessionGuid, int streamFlags, out IntPtr audioVolume);
		void GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
	}

	[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IAudioSessionEnumerator
	{
		void GetCount(out int count);
		void GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
	}

	[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IAudioSessionControl2
	{
		void GetState(out int state);
		void GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
		void SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid eventContext);
		void GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
		void SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid eventContext);
		void GetGroupingParam(out Guid groupingParam);
		void SetGroupingParam(ref Guid groupingParam, ref Guid eventContext);
		void RegisterAudioSessionNotification(IntPtr client);
		void UnregisterAudioSessionNotification(IntPtr client);
		void GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
		void GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
		void GetProcessId(out uint pid);
		[PreserveSig] int IsSystemSoundsSession();
	}

	[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface ISimpleAudioVolume
	{
		void SetMasterVolume(float level, ref Guid eventContext);
		void GetMasterVolume(out float level);
		void SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
		void GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
	}

	class Session
	{
		public uint Pid;
		public bool IsSystemSounds;
		public int State;
		public string DisplayName;
		public string Device;
		public ISimpleAudioVolume Volume;
	}

	static class Program
	{
		const int CLSCTX_ALL = 23;
		const int DEVICE_STATE_ACTIVE = 1;
		const int STGM_READ = 0;
		const ushort VT_LPWSTR = 31;
		const int AUDIO_SESSION_STATE_ACTIVE = 1;
		const int AUDIO_SESSION_STATE_EXPIRED = 2;

		static Guid IID_IAudioEndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
		static Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
		static PropertyKey PKEY_Device_FriendlyName = new PropertyKey
		{
			fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),
			pid = 14,
		};
		static Guid EventContext = Guid.Empty;

		static IMMDeviceEnumerator enumerator;
		static readonly Dictionary<uint, string[]> processInfoCache = new Dictionary<uint, string[]>();

		[DllImport("ole32.dll")]
		static extern int PropVariantClear(ref PropVariant pvar);

		[MTAThread]
		static int Main()
		{
			var utf8 = new UTF8Encoding(false);
			var input = new StreamReader(Console.OpenStandardInput(), utf8);
			var output = new StreamWriter(Console.OpenStandardOutput(), utf8);
			output.AutoFlush = true;
			output.NewLine = "\n";

			enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();

			string line;
			while ((line = input.ReadLine()) != null)
			{
				line = line.Trim();
				if (line.Length == 0) continue;

				string response;
				try
				{
					response = Handle(line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries));
				}
				catch (Exception e)
				{
					response = "{\"error\":" + Json(e.Message) + "}";
				}
				output.WriteLine(response);
			}
			return 0;
		}

		static string Handle(string[] args)
		{
			switch (args[0])
			{
				case "ping":
					return "{\"ok\":true}";
				case "get":
					return GetMaster();
				case "set-volume":
					{
						RequireArgs(args, 2);
						float level = ParsePercent(args[1]) / 100f;
						WithEndpointVolume(delegate (IAudioEndpointVolume v)
						{
							v.SetMasterVolumeLevelScalar(level, ref EventContext);
						});
						return GetMaster();
					}
				case "set-mute":
					{
						RequireArgs(args, 2);
						bool mute = ParseBool(args[1]);
						WithEndpointVolume(delegate (IAudioEndpointVolume v)
						{
							v.SetMute(mute, ref EventContext);
						});
						return GetMaster();
					}
				case "apps":
					return ListApps();
				case "app-volume":
					{
						RequireArgs(args, 3);
						float level = ParsePercent(args[2]) / 100f;
						int count = ForEachSessionOf(ParsePid(args[1]), delegate (Session s)
						{
							s.Volume.SetMasterVolume(level, ref EventContext);
						});
						return Changed(count);
					}
				case "app-mute":
					{
						RequireArgs(args, 3);
						bool mute = ParseBool(args[2]);
						int count = ForEachSessionOf(ParsePid(args[1]), delegate (Session s)
						{
							s.Volume.SetMute(mute, ref EventContext);
						});
						return Changed(count);
					}
				default:
					throw new ArgumentException("Unknown command: " + args[0]);
			}
		}

		static string Changed(int count)
		{
			if (count == 0) throw new InvalidOperationException("No audio session found for that process");
			return "{\"ok\":true,\"count\":" + count + "}";
		}

		// ----- master volume (default multimedia output device) -----

		static IMMDevice GetDefaultDevice()
		{
			IMMDevice device;
			int hr = enumerator.GetDefaultAudioEndpoint(EDataFlow.Render, ERole.Multimedia, out device);
			if (hr != 0 || device == null) throw new InvalidOperationException("No default audio output device");
			return device;
		}

		static void WithEndpointVolume(Action<IAudioEndpointVolume> action)
		{
			IMMDevice device = GetDefaultDevice();
			object o = null;
			try
			{
				device.Activate(ref IID_IAudioEndpointVolume, CLSCTX_ALL, IntPtr.Zero, out o);
				action((IAudioEndpointVolume)o);
			}
			finally
			{
				Release(o);
				Release(device);
			}
		}

		static string GetMaster()
		{
			IMMDevice device = GetDefaultDevice();
			object o = null;
			try
			{
				device.Activate(ref IID_IAudioEndpointVolume, CLSCTX_ALL, IntPtr.Zero, out o);
				var v = (IAudioEndpointVolume)o;
				float level;
				bool muted;
				v.GetMasterVolumeLevelScalar(out level);
				v.GetMute(out muted);
				return "{\"volume\":" + Percent(level) + ",\"muted\":" + Bool(muted) + ",\"device\":" + Json(FriendlyName(device)) + "}";
			}
			finally
			{
				Release(o);
				Release(device);
			}
		}

		static string FriendlyName(IMMDevice device)
		{
			IPropertyStore store = null;
			try
			{
				device.OpenPropertyStore(STGM_READ, out store);
				PropVariant value;
				store.GetValue(ref PKEY_Device_FriendlyName, out value);
				try
				{
					return value.vt == VT_LPWSTR ? Marshal.PtrToStringUni(value.pointerValue) : null;
				}
				finally
				{
					PropVariantClear(ref value);
				}
			}
			catch
			{
				return null;
			}
			finally
			{
				Release(store);
			}
		}

		// ----- per-application sessions -----

		// Visits every live session on every active output device. The session's COM objects are only
		// valid inside the callback.
		static void ForEachSession(Action<Session> action)
		{
			IMMDeviceCollection devices;
			enumerator.EnumAudioEndpoints(EDataFlow.Render, DEVICE_STATE_ACTIVE, out devices);
			try
			{
				int deviceCount;
				devices.GetCount(out deviceCount);
				for (int d = 0; d < deviceCount; d++)
				{
					IMMDevice device;
					devices.Item(d, out device);
					object managerObj = null;
					IAudioSessionEnumerator sessions = null;
					try
					{
						device.Activate(ref IID_IAudioSessionManager2, CLSCTX_ALL, IntPtr.Zero, out managerObj);
						((IAudioSessionManager2)managerObj).GetSessionEnumerator(out sessions);
						string deviceName = FriendlyName(device);
						int sessionCount;
						sessions.GetCount(out sessionCount);
						for (int i = 0; i < sessionCount; i++)
						{
							object sessionObj;
							sessions.GetSession(i, out sessionObj);
							try
							{
								var control = (IAudioSessionControl2)sessionObj;
								var session = new Session();
								control.GetState(out session.State);
								if (session.State == AUDIO_SESSION_STATE_EXPIRED) continue;
								session.IsSystemSounds = control.IsSystemSoundsSession() == 0;
								control.GetProcessId(out session.Pid);
								if (session.IsSystemSounds) session.Pid = 0;
								control.GetDisplayName(out session.DisplayName);
								session.Device = deviceName;
								session.Volume = (ISimpleAudioVolume)sessionObj;
								action(session);
							}
							finally
							{
								Release(sessionObj);
							}
						}
					}
					finally
					{
						Release(sessions);
						Release(managerObj);
						Release(device);
					}
				}
			}
			finally
			{
				Release(devices);
			}
		}

		static int ForEachSessionOf(uint pid, Action<Session> action)
		{
			int count = 0;
			ForEachSession(delegate (Session s)
			{
				if (s.Pid != pid) return;
				action(s);
				count++;
			});
			return count;
		}

		static string ListApps()
		{
			var sb = new StringBuilder("{\"apps\":[");
			bool first = true;
			ForEachSession(delegate (Session s)
			{
				string[] info = ProcessInfo(s);
				if (info == null) return; // process already gone

				float level;
				bool muted;
				s.Volume.GetMasterVolume(out level);
				s.Volume.GetMute(out muted);

				if (!first) sb.Append(',');
				first = false;
				sb.Append("{\"pid\":").Append(s.Pid)
					.Append(",\"name\":").Append(Json(info[0]))
					.Append(",\"title\":").Append(Json(info[1]))
					.Append(",\"volume\":").Append(Percent(level))
					.Append(",\"muted\":").Append(Bool(muted))
					.Append(",\"active\":").Append(Bool(s.State == AUDIO_SESSION_STATE_ACTIVE))
					.Append(",\"device\":").Append(Json(s.Device))
					.Append('}');
			});
			return sb.Append("]}").ToString();
		}

		// Returns { processName, displayTitle }, or null if the process no longer exists.
		static string[] ProcessInfo(Session s)
		{
			if (s.IsSystemSounds) return new[] { "System Sounds", "System Sounds" };

			string name;
			try
			{
				using (var p = Process.GetProcessById((int)s.Pid)) name = p.ProcessName;
			}
			catch
			{
				processInfoCache.Remove(s.Pid);
				return null;
			}

			string[] cached;
			if (processInfoCache.TryGetValue(s.Pid, out cached) && cached[0] == name) return cached;

			string title = null;
			if (!string.IsNullOrEmpty(s.DisplayName) && !s.DisplayName.StartsWith("@")) title = s.DisplayName;
			if (title == null)
			{
				try
				{
					using (var p = Process.GetProcessById((int)s.Pid))
					{
						string description = p.MainModule.FileVersionInfo.FileDescription;
						if (!string.IsNullOrWhiteSpace(description)) title = description.Trim();
					}
				}
				catch
				{
					// Access denied for elevated or protected processes; fall back to the process name.
				}
			}

			var result = new[] { name, title ?? name };
			processInfoCache[s.Pid] = result;
			return result;
		}

		// ----- helpers -----

		static void RequireArgs(string[] args, int count)
		{
			if (args.Length < count) throw new ArgumentException("Missing argument for " + args[0]);
		}

		static float ParsePercent(string s)
		{
			double v;
			if (!double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v) || v < 0 || v > 100)
				throw new ArgumentException("Volume must be a number between 0 and 100");
			return (float)v;
		}

		static bool ParseBool(string s)
		{
			if (s == "1" || s == "true") return true;
			if (s == "0" || s == "false") return false;
			throw new ArgumentException("Expected 0 or 1");
		}

		static uint ParsePid(string s)
		{
			uint pid;
			if (!uint.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out pid))
				throw new ArgumentException("Invalid process id");
			return pid;
		}

		static string Percent(float level)
		{
			return ((int)Math.Round(level * 100f)).ToString(CultureInfo.InvariantCulture);
		}

		static string Bool(bool b)
		{
			return b ? "true" : "false";
		}

		static string Json(string s)
		{
			if (s == null) return "null";
			var sb = new StringBuilder("\"");
			foreach (char c in s)
			{
				switch (c)
				{
					case '"': sb.Append("\\\""); break;
					case '\\': sb.Append("\\\\"); break;
					case '\n': sb.Append("\\n"); break;
					case '\r': sb.Append("\\r"); break;
					case '\t': sb.Append("\\t"); break;
					default:
						if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
						else sb.Append(c);
						break;
				}
			}
			return sb.Append('"').ToString();
		}

		static void Release(object o)
		{
			if (o != null && Marshal.IsComObject(o)) Marshal.ReleaseComObject(o);
		}
	}
}
